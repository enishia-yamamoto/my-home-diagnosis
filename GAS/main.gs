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
// ==========================================
// デバッグログ用関数
// ==========================================
function logToSheet(msg) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Debug');
    if (!sheet) {
      sheet = ss.insertSheet('Debug');
      sheet.appendRow(['Timestamp', 'Message']);
    }
    sheet.appendRow([new Date(), msg]);
  } catch (e) {
    console.error('Sheet Log Error:', e);
  }
}

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
  try {
    console.log('doPost START');
    logToSheet('doPost START');
    
    // リクエスト内容の確認
    if (e && e.postData) {
      console.log('ContentType:', e.postData.type);
      logToSheet('ContentType: ' + e.postData.type);
      console.log('Contents:', e.postData.contents);
      logToSheet('Contents: ' + e.postData.contents);
    } else {
      console.error('No postData received');
      logToSheet('Error: No postData received');
      return createJsonResponse({ status: 'error', message: 'No postData' });
    }

    let json;
    try {
      json = JSON.parse(e.postData.contents);
    } catch (error) {
      console.error('JSON Parse Error:', error);
      logToSheet('Error: JSON Parse Error: ' + error.message);
      return createJsonResponse({ status: 'error', message: 'Invalid JSON' });
    }

    // 診断データ送信の場合
    if (json.type === 'diagnosis') {
      console.log('Processing Diagnosis API');
      logToSheet('Processing Diagnosis API');
      return handleDiagnosisApi(json.data);
    }
  
    // LINE Webhookの場合
    if (json.events) {
      console.log('Processing LINE Webhook');
      logToSheet('Processing LINE Webhook');
      return handleLineWebhook(json);
    }

    // どのタイプにもマッチしない場合
    if (json.userId) {
       console.log('Assuming flat diagnosis data based on userId');
       logToSheet('Assuming flat diagnosis data based on userId');
       return handleDiagnosisApi(json);
    }

    console.warn('Unknown request type:', JSON.stringify(json));
    logToSheet('Error: Unknown request type: ' + JSON.stringify(json));
    return createJsonResponse({ status: 'error', message: 'Unknown request type' });

  } catch (error) {
    console.error('Global Error in doPost:', error);
    logToSheet('Global Error in doPost: ' + error.toString());
    return createJsonResponse({ status: 'error', message: error.toString() });
  }
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

    // ユーザーデータ保存（上書き）
    saveUserData(data.userId, {
      ...result,
      conversationId: getConversationId(data.userId) // 既存の会話IDがあれば維持
    });

    // LINEへ通知
    const flexMessage = MessageBuilder.createDiagnosisResult(result);
    line.pushMessage(result.userId, flexMessage);

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

    // ユーザーデータ取得
    const userData = getUserData(userId);
    const conversationId = userData ? userData.conversationId : null;
    
    // Dify応答
    let answer;
    if (userData) {
      // 診断データがあればContextとして渡す
      answer = dify.chatWithDiagnosis(userId, text, userData, conversationId);
    } else {
      answer = dify.chat(userId, text, {}, conversationId);
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
      propertyType: input.propertyType,
      targetArea: input.targetArea,
      targetAreaOther: input.targetAreaOther,
      mustConditions: input.mustConditions,
      maxBudget: maxBudget,
      safeBudget: safeBudget,
      monthlyPaymentMax: Math.floor(maxMonthlyPayment),
      monthlyPaymentSafe: Math.floor(safeMonthlyPayment),
      monthlyPaymentMax: Math.floor(maxMonthlyPayment),
      monthlyPaymentSafe: Math.floor(safeMonthlyPayment),
      rank: rank,
      propertyType: input.propertyType // 追加
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
    try {
      const response = UrlFetchApp.fetch(`${this.apiUrl}/push`, {
        method: 'post',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        payload: JSON.stringify({ to: userId, messages: messages }),
        muteHttpExceptions: true
      });
      const responseCode = response.getResponseCode();
      const responseBody = response.getContentText();
      if (responseCode !== 200) {
        console.error('LINE Push Failed:', responseCode, responseBody);
        logToSheet('LINE Push Failed: ' + responseCode + ' ' + responseBody);
        console.error('Payload:', JSON.stringify({ to: userId, messages: messages }));
        logToSheet('Payload: ' + JSON.stringify({ to: userId, messages: messages }));
      } else {
        console.log('LINE Push Success');
        logToSheet('LINE Push Success');
      }
    } catch (e) {
      console.error('LINE Push Error:', e);
      logToSheet('LINE Push Error: ' + e.toString());
      console.error('Payload:', JSON.stringify({ to: userId, messages: messages }));
      logToSheet('Payload: ' + JSON.stringify({ to: userId, messages: messages }));
    }
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
    const ratio = Math.min(Math.floor((result.safeBudget / result.maxBudget) * 100), 100);
    
    // ランク別アドバイス
    let advice = '';
    if (result.rank === 'A') advice = '余裕のある予算設定です！\n希望エリアのグレードを上げたり、設備にこだわることも可能です。';
    else if (result.rank === 'B') advice = 'バランスの良い予算です。\n物件価格だけでなく、諸費用や引越し代も考慮して進めましょう。';
    else advice = '少し予算オーバーの可能性があります。\nエリアを見直すか、自己資金を増やすことを検討しましょう。';

    return {
      type: 'flex',
      altText: 'マイホーム診断結果',
      contents: {
        type: 'bubble',
        size: 'mega', // サイズ大きく
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: 'マイホーム適正予算診断', color: '#ffffffaa', size: 'xs' },
            { type: 'text', text: `判定：${result.rank}ランク`, weight: 'bold', color: '#FFFFFF', size: 'xl', margin: 'md' }
          ],
          backgroundColor: color
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: 'あなたの適正予算', size: 'sm', color: '#888888', align: 'center' },
            { 
              type: 'text', 
              text: `${result.safeBudget.toLocaleString()}万円`, 
              size: 'xxl', 
              weight: 'bold', 
              color: '#333333', 
              align: 'center', 
              margin: 'sm' 
            },
            { type: 'separator', margin: 'xl' },
            // 予算サマリー
            {
              type: 'box',
              layout: 'vertical',
              margin: 'xl',
              contents: [
                {
                  type: 'box',
                  layout: 'horizontal',
                  contents: [
                    { type: 'text', text: '借入上限額', size: 'sm', color: '#555555', flex: 1 },
                    { type: 'text', text: `${result.maxBudget.toLocaleString()}万円`, size: 'sm', color: '#111111', align: 'end', flex: 1 }
                  ]
                },
                // プログレスバー背景
                {
                  type: 'box',
                  layout: 'vertical',
                  margin: 'sm',
                  backgroundColor: '#EBEBEB',
                  height: '6px',
                  cornerRadius: '3px',
                  contents: [
                    // プログレスバー本体
                    {
                      type: 'box',
                      layout: 'vertical',
                      width: `${ratio}%`,
                      backgroundColor: color,
                      height: '6px',
                      cornerRadius: '3px',
                      contents: [] // 追加: 空でもcontentsは必須
                    }
                  ]
                },
                { type: 'text', text: `安全圏: ${ratio}%`, size: 'xs', color: '#aaaaaa', align: 'end', margin: 'xs' }
              ]
            },
            // 月々返済
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'lg',
              contents: [
                { type: 'text', text: '月々返済目安', size: 'sm', color: '#555555', flex: 1 },
                { type: 'text', text: `${result.monthlyPaymentSafe.toLocaleString()}円`, size: 'md', weight: 'bold', color: '#111111', align: 'end', flex: 1 }
              ]
            },
            { type: 'separator', margin: 'xl' },
            // アドバイス
            {
              type: 'box',
              layout: 'vertical',
              margin: 'xl',
              backgroundColor: '#f8f8f8',
              cornerRadius: '8px',
              paddingAll: 'md',
              contents: [
                { type: 'text', text: '💡 アドバイス', weight: 'bold', size: 'sm', color: color },
                { type: 'text', text: advice, size: 'xs', color: '#555555',  wrap: true, margin: 'sm', lineHeight: '1.6' }
              ]
            },
            // 希望条件
            {
              type: 'text',
              text: 'あなたの希望整理シート',
              weight: 'bold',
              size: 'sm',
              margin: 'xl',
              color: '#333333'
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'sm',
              spacing: 'xs',
              contents: [
                {
                  type: 'box',
                  layout: 'horizontal',
                  contents: [
                    { type: 'text', text: '物件種別', size: 'xs', color: '#888888', flex: 1 },
                    { type: 'text', text: result.propertyType || '未指定', size: 'xs', color: '#333333', flex: 2 }
                  ]
                },
                {
                  type: 'box',
                  layout: 'horizontal',
                  contents: [
                    { type: 'text', text: '希望エリア', size: 'xs', color: '#888888', flex: 1 },
                    { type: 'text', text: result.targetArea, size: 'xs', color: '#333333', flex: 2 }
                  ]
                },
                {
                  type: 'box',
                  layout: 'horizontal',
                  contents: [
                    { type: 'text', text: '現在家賃', size: 'xs', color: '#888888', flex: 1 },
                    { type: 'text', text: `${Number(result.currentRent).toLocaleString()}円`, size: 'xs', color: '#333333', flex: 2 }
                  ]
                },
                {
                  type: 'box',
                  layout: 'horizontal',
                  margin: 'md',
                  contents: [
                    { type: 'text', text: '重視条件', size: 'xs', color: '#888888', flex: 1 },
                    { type: 'text', text: result.mustConditions || '特になし', size: 'xs', color: '#00B900', weight: 'bold', flex: 2, wrap: true }
                  ]
                }
              ]
            }
          ]
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: color,
              height: 'sm',
              action: {
                type: 'message',
                label: 'この条件でプロに相談',
                text: `【相談希望】\n予算:${result.safeBudget}万円\nエリア:${result.targetArea}\n条件:${result.mustConditions}`
              }
            },
            {
              type: 'button',
              style: 'link',
              height: 'sm',
              action: {
                type: 'message',
                label: '条件を変更して再診断',
                text: '再診断したいです' // 実際にはメニューからやってもらうが、アクションとしてはあり
              }
            }
          ]
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
    this.apiUrl = 'https://ai-works.xvps.jp/v1';
  }

  chat(userId, query, inputs = {}, conversationId = null) {
    try {
      const payload = {
        inputs: inputs,
        query: query,
        response_mode: "blocking",
        user: userId,
        conversation_id: conversationId || "",
        files: []
      };
      
      const response = UrlFetchApp.fetch(`${this.apiUrl}/chat-messages`, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const json = JSON.parse(response.getContentText());
      if (response.getResponseCode() !== 200) {
        throw new Error(`Dify API Error: ${response.getResponseCode()} ${JSON.stringify(json)}`);
      }
      
      // 会話IDを保存
      if (json.conversation_id) {
        saveUserConversationId(userId, json.conversation_id);
      }
      
      return json.answer || '申し訳ありません。回答を生成できませんでした。';
    } catch (e) {
      console.error('Dify Error:', e.toString());
      logToSheet('Dify Error: ' + e.toString());
      // APIキー漏洩防止のため、ログには詳細を出さないが、デバッグ時は必要
      // logToSheet('API Key: ' + this.apiKey); 
      return '現在、システムが応答できません。（管理者へ：ConfigシートのDIFY_API_KEY設定や、GASのDebugシートのログを確認してください）';
    }
  }

  chatWithDiagnosis(userId, query, diagnosis, conversationId) {
    return this.chat(userId, query, {
      incom: diagnosis.annualIncome,
      budget: diagnosis.safeBudget,
      area: diagnosis.targetArea,
      conditions: diagnosis.mustConditions,
      family: diagnosis.familyStructure
    }, conversationId);
  }
}

// ==========================================
// 6. ユーティリティ (Log, GetDiagnosis)
// ==========================================
// ==========================================
// 6. ユーザーデータ管理 (Users Sheet)
// ==========================================
const USERS_SHEET_NAME = 'Users';

function getUserData(userId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) return null;
  
  const data = sheet.getDataRange().getValues();
  // ヘッダー: UserId, AnnualIncome, OwnCapital, CurrentRent, Family, Area, Conditions, SafeBudget, MaxBudget, Rank, ConversationId, Updated
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      return {
        userId: data[i][0],
        annualIncome: data[i][1],
        ownCapital: data[i][2],
        currentRent: data[i][3],
        familyStructure: data[i][4],
        propertyType: data[i][5],
        targetArea: data[i][6],
        mustConditions: data[i][7],
        safeBudget: data[i][8],
        maxBudget: data[i][9],
        rank: data[i][10],
        conversationId: data[i][11]
      };
    }
  }
  return null;
}

function saveUserData(userId, data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET_NAME);
    sheet.appendRow([
      'UserId', 'AnnualIncome', 'OwnCapital', 'CurrentRent', 'FamilyStructure', 'PropertyType',
      'TargetArea', 'MustConditions', 'SafeBudget', 'MaxBudget', 'Rank', 
      'ConversationId', 'Updated'
    ]);
  }
  
  const rows = sheet.getDataRange().getValues();
  let rowIndex = -1;
  
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === userId) {
      rowIndex = i + 1;
      break;
    }
  }
  
  // エリアの加工（その他入力がある場合）
  let finalArea = data.targetArea || '';
  if (finalArea.includes('その他') && data.targetAreaOther) {
    finalArea = `その他（${data.targetAreaOther}）`;
  }

  // 更新データの準備
  const rowData = [
    userId,
    data.annualIncome || '',
    data.ownCapital || '',
    data.currentRent || '',
    data.familyStructure || '',
    data.propertyType || '',
    finalArea,
    data.mustConditions || '',
    data.safeBudget || '',
    data.maxBudget || '',
    data.rank || '',
    data.conversationId || '',
    new Date()
  ];

  if (rowIndex > 0) {
    // 既存行の更新 (ConversationIdが空の場合は既存を維持する処理を入れるべきだが、
    // 引数 data.conversationId に existing value を渡すことで対応)
    sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
  } else {
    // 新規作成
    sheet.appendRow(rowData);
  }
}

function saveUserConversationId(userId, conversationId) {
  const userData = getUserData(userId) || {};
  userData.conversationId = conversationId;
  saveUserData(userId, userData);
}

// 既存の saveLog, getConversationId, saveConversationId, getLatestDiagnosis は削除
function getConversationId(userId) {
  const data = getUserData(userId);
  return data ? data.conversationId : null;
}
