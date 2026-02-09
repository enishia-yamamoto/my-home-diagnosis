/**
 * マイホーム診断ボット Backend (GAS) - 統合版
 * 
 * 含まれる機能:
 * 1. APIハンドラ (doPost)
 * 2. 設定管理 (Config)
 * 3. 予算計算ロジック (Calculator)
 * 4. LINE Messaging API連携 (LINE)
 * 5. Dify AIチャット連携 (Dify)
 */

// ==========================================
// 1. APIハンドラ (Main)
// ==========================================

/**
 * 共通処理: OPTIONSリクエストへの対応 (CORSプリフライト用)
 */
function doOptions(e) {
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * POSTリクエストハンドラ
 */
function doPost(e) {
  let json;
  try {
    json = JSON.parse(e.postData.contents);
  } catch (error) {
    return createJsonResponse({ status: 'error', message: 'Invalid JSON' });
  }

  // 診断データ送信の場合
  if (json.type === 'diagnosis') {
    return handleDiagnosisApi(json.data);
  }

  // LINE Webhookの場合
  if (json.events) {
    return handleLineWebhook(json);
  }

  return createJsonResponse({ status: 'error', message: 'Unknown request type' });
}

/**
 * 診断API処理
 */
function handleDiagnosisApi(data) {
  try {
    const config = getConfig();
    const calc = new Calculator(config);
    const line = new LINE(config);

    if (!data.userId) {
      return createJsonResponse({ status: 'error', message: 'UserId is required' });
    }

    // 計算実行
    const result = calc.calculateAll(data);

    // ログ保存
    saveLog(result);

    // LINEへ通知
    const flexMessage = MessageBuilder.createDiagnosisResult(result);
    // line.pushMessage(result.userId, flexMessage); // 必要に応じて有効化

    // 結果返却
    return createJsonResponse({
      status: 'success',
      result: result
    });

  } catch (error) {
    console.error('API Error:', error);
    return createJsonResponse({ status: 'error', message: error.toString() });
  }
}

/**
 * LINE Webhook処理
 */
function handleLineWebhook(json) {
  const events = json.events;
  for (const event of events) {
    handleLineEvent(event);
  }
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * LINEイベント個別処理
 */
function handleLineEvent(event) {
  const config = getConfig();
  const line = new LINE(config);
  const dify = new Dify(config);

  if (event.type === 'message' && event.message.type === 'text') {
    const userId = event.source.userId;
    const text = event.message.text;
    const replyToken = event.replyToken;

    // 相談希望などのキーワード処理
    if (text.startsWith('【相談希望】')) {
      const replyText = 'お問い合わせありがとうございます。\n担当者よりご連絡いたします。';
      line.replyMessage(replyToken, line.createTextMessage(replyText));
      return;
    }

    // 最新の診断結果を取得（コンテキスト用）
    const diagnosis = getLatestDiagnosis(userId);
    
    // Dify応答
    let answer;
    if (diagnosis) {
      answer = dify.chatWithDiagnosis(userId, text, diagnosis);
    } else {
      answer = dify.chat(userId, text, {});
    }

    line.replyMessage(replyToken, line.createTextMessage(answer));
  }
}

function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// 2. 設定管理 (Config)
// ==========================================
class Config {
  constructor() {
    this.sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
    this.cache = {}; 
    this.load();
  }

  load() {
    if (!this.sheet) return;
    const data = this.sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const key = data[i][0];
      const value = data[i][1];
      if (key) this.cache[key] = value;
    }
  }

  get(key) { return this.cache[key]; }
  get rateFloating() { return Number(this.get('RATE_FLOATING')); }
  get rateFixed() { return Number(this.get('RATE_FIXED')); }
  get termYears() { return Number(this.get('TERM_YEARS')); }
  get ratioSafe() { return Number(this.get('RATIO_SAFE')); }
  get ratioMax() { return Number(this.get('RATIO_MAX')); }
  get lineChannelAccessToken() { return this.get('LINE_CHANNEL_ACCESS_TOKEN'); }
  get difyApiKey() { return this.get('DIFY_API_KEY'); }
}

function getConfig() { return new Config(); }

// ==========================================
// 3. 予算計算ロジック (Calculator)
// ==========================================
class Calculator {
  constructor(config) { this.config = config; }

  pmt(rate, periods, present) {
    if (rate === 0) return present / periods;
    const monthlyRate = rate / 12;
    return (present * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -periods));
  }

  pv(rate, periods, payment) {
    if (rate === 0) return payment * periods;
    const monthlyRate = rate / 12;
    return payment * (1 - Math.pow(1 + monthlyRate, -periods)) / monthlyRate;
  }

  calculateAll(input) {
    const income = Number(input.annualIncome);
    const capital = Number(input.ownCapital);
    const years = this.config.termYears;
    const months = years * 12;

    // 借入上限
    const maxMonthlyPayment = (income * 10000 * this.config.ratioMax) / 12;
    const maxLoan = this.pv(this.config.rateFloating / 100, months, maxMonthlyPayment);
    const maxBudget = Math.floor((maxLoan + capital * 10000) / 10000);

    // 適正予算
    const safeMonthlyPayment = (income * 10000 * this.config.ratioSafe) / 12;
    const safeLoan = this.pv(this.config.rateFloating / 100, months, safeMonthlyPayment);
    const safeBudget = Math.floor((safeLoan + capital * 10000) / 10000);

    // ランク判定
    let rank = 'B';
    const safetyRatio = safeBudget / maxBudget;
    if (safetyRatio > 0.8) rank = 'A';
    else if (safetyRatio < 0.6) rank = 'C';

    return {
      userId: input.userId,
      annualIncome: income,
      ownCapital: capital,
      currentRent: input.currentRent,
      familyStructure: input.familyStructure,
      targetArea: input.targetArea,
      mustConditions: input.mustConditions,
      maxBudget: maxBudget,
      safeBudget: safeBudget,
      monthlyPaymentMax: Math.floor(maxMonthlyPayment),
      monthlyPaymentSafe: Math.floor(safeMonthlyPayment),
      rank: rank
    };
  }
}

// ==========================================
// 4. LINE Messaging API連携 (LINE)
// ==========================================
class LINE {
  constructor(config) {
    this.token = config.lineChannelAccessToken;
    this.apiUrl = 'https://api.line.me/v2/bot/message';
  }

  pushMessage(userId, messages) {
    if (!Array.isArray(messages)) messages = [messages];
    UrlFetchApp.fetch(`${this.apiUrl}/push`, {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
      payload: JSON.stringify({ to: userId, messages: messages })
    });
  }

  replyMessage(replyToken, messages) {
    if (!Array.isArray(messages)) messages = [messages];
    UrlFetchApp.fetch(`${this.apiUrl}/reply`, {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
      payload: JSON.stringify({ replyToken: replyToken, messages: messages })
    });
  }

  createTextMessage(text) { return { type: 'text', text: text }; }
}

class MessageBuilder {
  static createDiagnosisResult(result) {
    const color = result.rank === 'A' ? '#06C755' : (result.rank === 'B' ? '#FF9800' : '#E53935');
    return {
      type: 'flex',
      altText: 'マイホーム診断結果',
      contents: {
        type: 'bubble',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [{ type: 'text', text: `診断結果：${result.rank}ランク`, weight: 'bold', color: '#FFFFFF', size: 'lg' }],
          backgroundColor: color
        },
        hero: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '適正予算目安', size: 'xs', color: '#aaaaaa', align: 'center' },
            { type: 'text', text: `${result.safeBudget.toLocaleString()}万円`, size: 'xxl', weight: 'bold', color: '#333333', align: 'center', margin: 'md' }
          ],
          paddingAll: 'xl'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '借入上限', size: 'sm', color: '#555555', flex: 1 },
                { type: 'text', text: `${result.maxBudget.toLocaleString()}万円`, size: 'sm', color: '#111111', align: 'end', flex: 1 }
              ],
              margin: 'md'
            },
            { type: 'separator', margin: 'md' },
            { type: 'text', text: '希望条件', weight: 'bold', size: 'sm', margin: 'lg', color: '#555555' },
            { type: 'text', text: `エリア: ${result.targetArea}`, size: 'xs', color: '#666666', margin: 'sm' }
          ]
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [{
            type: 'button',
            style: 'primary',
            color: color,
            action: { type: 'message', label: 'この条件でプロに相談', text: `【相談希望】\n予算:${result.safeBudget}万円\nエリア:${result.targetArea}` }
          }]
        }
      }
    };
  }
}

// ==========================================
// 5. Dify AIチャット連携 (Dify)
// ==========================================
class Dify {
  constructor(config) {
    this.apiKey = config.difyApiKey;
    this.apiUrl = 'https://api.dify.ai/v1';
  }

  chat(userId, query, inputs = {}) {
    try {
      const response = UrlFetchApp.fetch(`${this.apiUrl}/chat-messages`, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        payload: JSON.stringify({
          inputs: inputs, query: query, response_mode: "blocking",
          user: userId, files: []
        }),
        muteHttpExceptions: true
      });
      const json = JSON.parse(response.getContentText());
      return json.answer || 'エラーが発生しました';
    } catch (e) {
      console.error('Dify Error:', e);
      return 'システム混雑中です。';
    }
  }

  chatWithDiagnosis(userId, query, diagnosis) {
    return this.chat(userId, query, {
      income: diagnosis.annualIncome,
      budget: diagnosis.safeBudget,
      area: diagnosis.targetArea,
      conditions: diagnosis.mustConditions
    });
  }
}

// ==========================================
// 6. ユーティリティ (Log, GetDiagnosis)
// ==========================================
function saveLog(result) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Log');
  if (!sheet) {
    sheet = ss.insertSheet('Log');
    sheet.appendRow(['Timestamp', 'UserId', 'AnnualIncome', 'SafeBudget', 'Rank', 'Area']);
  }
  sheet.appendRow([new Date(), result.userId, result.annualIncome, result.safeBudget, result.rank, result.targetArea]);
}

function getLatestDiagnosis(userId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Log');
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === userId) {
      return {
        annualIncome: data[i][2],
        safeBudget: data[i][3],
        targetArea: data[i][5],
        mustConditions: ''
      };
    }
  }
  return null;
}
