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
// 1. 設定 (Configuration)
// ==========================================
// APIキーや設定値は「プロジェクトの設定 > スクリプトプロパティ」に保存してください。
// キー名: LINE_CHANNEL_ACCESS_TOKEN, DIFY_API_KEY, LIFF_ID, RATE_FLOATING, RATE_FIXED等
// ※ スクリプトプロパティ未設定時は以下のデフォルト値が適用されます
const DEFAULT_RATE_FLOATING = 0.5; // 変動金利 (%)
const DEFAULT_RATE_FIXED = 1.8;    // 固定金利 (%)
const DEFAULT_TERM_YEARS = 35;     // 返済期間 (年)
const DEFAULT_RATIO_SAFE = 0.20;   // 安全返済比率 (20%)
const DEFAULT_RATIO_MAX = 0.35;    // 上限返済比率 (35%)

// ==========================================
// 2. APIハンドラ (Main)
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

/**
 * 診断API処理
 */
function parseDiagnosisData(raw) {
  const ans = raw.answers || {};
  
  // 年収の数値化（万円）
  let income = 0;
  if (ans.q2) {
    if (ans.q2.value === 'MANUAL') {
      income = Number(ans.q2.extra);
    } else {
      const incomeMap = {
        'LT_400': 350, '400_600': 500, '600_800': 700, '800_1000': 900, 'GT_1000': 1200
      };
      income = incomeMap[ans.q2.value] || 0;
    }
  }

  // 既存借入（月々）
  let debt = 0;
  if (ans.q5 && ans.q5.extra) { debt = Number(ans.q5.extra); }

  // 家賃
  let rent = 0;
  if (ans.q6 && ans.q6.extra) { rent = Number(ans.q6.extra); }

  // エリア
  let area = '';
  if (ans.q9 && ans.q9.value) {
    area = (typeof ans.q9.value === 'object') 
      ? `${ans.q9.value.pref} ${ans.q9.value.city}` 
      : ans.q9.value;
  }

  // 希望予算 (Q13) - ゾーン判定用
  let desired = 0;
  if (ans.q13) {
    const budgetMap = { 'LT_2000': 2000, '2000_3000': 2500, '3000_4000': 3500, 'GT_4000': 4500, 'UNKNOWN': 0 };
    desired = budgetMap[ans.q13.value] || 0;
  }

  // --- 各質問のラベル（そのまま保存用） ---
  const label = (qId) => {
    if (!ans[qId]) return '';
    // checkboxの場合はlabelがカンマ区切り文字列
    return ans[qId].label || '';
  };
  // Q2: 手動入力の場合はextraも付ける
  let q2Label = label('q2');
  if (ans.q2 && ans.q2.value === 'MANUAL' && ans.q2.extra) {
    q2Label = `${ans.q2.extra}万円`;
  }
  // Q5: 借入ありの場合は月額も付ける
  let q5Label = label('q5');
  if (ans.q5 && ans.q5.extra) {
    q5Label += `（月${Number(ans.q5.extra).toLocaleString()}円）`;
  }
  // Q6: 賃貸の場合は家賃も付ける
  let q6Label = label('q6');
  if (ans.q6 && ans.q6.extra) {
    q6Label += `（月${Number(ans.q6.extra).toLocaleString()}円）`;
  }

  return {
    userId: raw.userId,
    userName: raw.userName || '',
    heatLevel: raw.heatLevel,
    // 計算用数値
    annualIncome: income,
    monthlyDebt: debt,
    currentRent: rent,
    ownCapital: 0,
    desiredBudget: desired,
    // 各質問の生ラベル（スプシ保存用）
    q1Label: label('q1'),   // 購入時期
    q2Label: q2Label,        // 世帯年収
    q3Label: label('q3'),   // 雇用形態
    q4Label: label('q4'),   // 勤続年数
    q5Label: q5Label,        // 既存借入
    q6Label: q6Label,        // 現在の住まい
    q7Label: label('q7'),   // 家族構成
    q8Label: label('q8'),   // 将来の予定
    q9Label: area,            // 希望エリア
    q10Label: label('q10'), // 物件タイプ
    q11Label: label('q11'), // 譲れない条件
    q12Label: label('q12'), // 不安なこと
    q13Label: label('q13'), // 希望価格帯
    // その他
    targetArea: area,
    propertyType: ans.q10 ? ans.q10.label : '',
    mustConditions: ans.q11 ? ans.q11.label : '',
    rawAnswers: ans
  };
}

/**
 * 診断ID生成（YYYYMMDD-XXX 形式、ランダム英数3桁）
 */
function generateDiagnosisId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dateStr = `${y}${m}${d}`;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rand = '';
  for (let i = 0; i < 3; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${dateStr}-${rand}`;
}

function handleDiagnosisApi(data) {
  try {
    const config = getConfig();
    const calc = new Calculator(config);
    const line = new LINE(config);

    if (!data.userId) {
      return createJsonResponse({ status: 'error', message: 'UserId is required' });
    }

    // データパース
    const parsedData = parseDiagnosisData(data);

    // 診断ID生成
    const diagnosisId = generateDiagnosisId();

    // userName取得（フロントから来なかった場合、LINE Profile APIで取得）
    if (!parsedData.userName && data.userId) {
      try {
        const config = getConfig();
        const profileRes = UrlFetchApp.fetch(`https://api.line.me/v2/bot/profile/${data.userId}`, {
          headers: { 'Authorization': `Bearer ${config.lineChannelAccessToken}` },
          muteHttpExceptions: true
        });
        if (profileRes.getResponseCode() === 200) {
          const profileJson = JSON.parse(profileRes.getContentText());
          parsedData.userName = profileJson.displayName || '';
        }
      } catch (e) {
        console.log('Profile fetch failed:', e);
      }
    }

    // 計算実行
    const result = calc.calculateAll(parsedData);

    // 全ラベルを結果にマージ（保存用）
    const fullResult = {
      ...result,
      diagnosisId: diagnosisId,
      userName: parsedData.userName,
      heatLevel: parsedData.heatLevel,
      conversationId: getConversationId(data.userId),
      q1Label: parsedData.q1Label,
      q2Label: parsedData.q2Label,
      q3Label: parsedData.q3Label,
      q4Label: parsedData.q4Label,
      q5Label: parsedData.q5Label,
      q6Label: parsedData.q6Label,
      q7Label: parsedData.q7Label,
      q8Label: parsedData.q8Label,
      q9Label: parsedData.q9Label,
      q10Label: parsedData.q10Label,
      q11Label: parsedData.q11Label,
      q12Label: parsedData.q12Label,
      q13Label: parsedData.q13Label
    };

    // ユーザーデータ保存（上書き）
    saveUserData(data.userId, fullResult);

    // ログ保存（追記）
    saveLogData(data.userId, fullResult);

    // LINEへ通知
    const flexMessage = MessageBuilder.createDiagnosisResult(fullResult);
    line.pushMessage(result.userId, flexMessage);

    // 結果返却
    return createJsonResponse({
      status: 'success',
      result: fullResult
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
// 2. 設定管理 (Config) - Script Properties使用
// ==========================================
class Config {
  constructor() {
    this.props = PropertiesService.getScriptProperties();
  }

  get(key) { return this.props.getProperty(key); }
  
  // API Keys (必須)
  get lineChannelAccessToken() { return this.get('LINE_CHANNEL_ACCESS_TOKEN'); }
  get difyApiKey() { return this.get('DIFY_API_KEY'); }
  get liffId() { return this.get('LIFF_ID'); }

  // 計算用定数 (未設定時はデフォルト値、パーセント値の場合は小数に変換)
  get rateFloating() { return Number(this.get('RATE_FLOATING')) || DEFAULT_RATE_FLOATING; }
  get rateFixed() { return Number(this.get('RATE_FIXED')) || DEFAULT_RATE_FIXED; }
  get termYears() { return Number(this.get('TERM_YEARS')) || DEFAULT_TERM_YEARS; }
  
  // 返済比率: 1より大きい値(例: 20)が入っていたら 0.2 に変換する安全策
  get ratioSafe() { 
    let val = Number(this.get('RATIO_SAFE')) || DEFAULT_RATIO_SAFE;
    if (val > 1) val = val / 100;
    return val;
  }
  get ratioMax() { 
    let val = Number(this.get('RATIO_MAX')) || DEFAULT_RATIO_MAX; 
    if (val > 1) val = val / 100;
    return val;
  }
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

    // ランク判定 (希望予算 vs 計算結果)
    let rank = 'B'; // Default (Caution/Standard)
    const desired = input.desiredBudget;
    
    if (desired > 0) {
        if (desired <= safeBudget) {
            rank = 'A'; // Safe
        } else if (desired > maxBudget) {
            rank = 'C'; // Danger
        } else {
            rank = 'B'; // Caution
        }
    } else {
        // 希望予算不明の場合はBとする（または、安全予算内ならAとも言えるが、不明確なのでCaution/Standard扱い）
        rank = 'B';
    }

    return {
      userId: input.userId,
      userName: input.userName,
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
    
    // ゾーン判定名
    let zoneTitle = '安全圏（Safe）';
    let zoneDesc = '無理のない返済計画です';
    let headerTitle = 'ゆとりある予算計画です✨';
    if (result.rank === 'B') {
      zoneTitle = '検討圏（Caution）';
      zoneDesc = '平均的な返済比率ですが、金利上昇に注意が必要です';
      headerTitle = '標準的な予算計画です';
    } else if (result.rank === 'C') {
      zoneTitle = '警戒圏（Danger）';
      zoneDesc = '借入上限に近く、余裕を持った計画が必要です';
      headerTitle = '予算超過の可能性があります';
    }

    // 金額を「範囲」で表示
    const roundBudget = (amount) => Math.floor(amount / 100) * 100;
    const minRange = roundBudget(result.safeBudget * 0.95);
    const maxRange = roundBudget(result.safeBudget * 1.05);
    const rangeText = `${minRange.toLocaleString()} 〜 ${maxRange.toLocaleString()}万円`;

    // 診断ID
    const diagnosisId = result.diagnosisId || '';

    return {
      type: 'flex',
      altText: 'マイホーム診断結果',
      contents: {
        type: 'bubble',
        size: 'giga',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '診断完了', color: '#ffffffaa', size: 'xs' },
            { type: 'text', text: headerTitle, weight: 'bold', color: '#FFFFFF', size: 'lg', margin: 'sm' },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'md',
              contents: [
                { type: 'text', text: `あなたの診断ID: ${diagnosisId}`, color: '#ffffffcc', size: 'xs' }
              ],
              paddingTop: 'sm',
              borderWidth: 'normal',
              borderColor: '#ffffff44',
              paddingStart: 'none',
              paddingEnd: 'none',
              paddingBottom: 'none'
            }
          ],
          backgroundColor: color,
          paddingAll: 'xl'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            // 希望整理シート
            {
              type: 'text',
              text: '📋 あなたの希望整理シート',
              weight: 'bold',
              size: 'sm',
              margin: 'xl',
              color: '#333333'
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'sm',
              spacing: 'sm',
              backgroundColor: '#fafafa',
              cornerRadius: '8px',
              paddingAll: 'md',
              contents: [
                {
                  type: 'box', layout: 'horizontal', contents: [
                    { type: 'text', text: '物件種別', size: 'xs', color: '#888888', flex: 2 },
                    { type: 'text', text: result.propertyType || '未指定', size: 'xs', color: '#333333', flex: 3 }
                  ]
                },
                {
                  type: 'box', layout: 'horizontal', contents: [
                    { type: 'text', text: '希望エリア', size: 'xs', color: '#888888', flex: 2 },
                    { type: 'text', text: result.targetArea || '未指定', size: 'xs', color: '#333333', flex: 3 }
                  ]
                },
                {
                  type: 'box', layout: 'horizontal', contents: [
                    { type: 'text', text: '現在家賃', size: 'xs', color: '#888888', flex: 2 },
                    { type: 'text', text: result.currentRent ? `${Number(result.currentRent).toLocaleString()}円` : '未指定', size: 'xs', color: '#333333', flex: 3 }
                  ]
                },
                {
                  type: 'box', layout: 'horizontal', contents: [
                    { type: 'text', text: '重視条件', size: 'xs', color: '#888888', flex: 2 },
                    { type: 'text', text: result.mustConditions || '未指定', size: 'xs', color: '#00B900', weight: 'bold', flex: 3, wrap: true }
                  ]
                }
              ]
            },

            // アドバイス
            {
              type: 'box',
              layout: 'vertical',
              margin: 'xl',
              backgroundColor: '#fff3e0',
              cornerRadius: '8px',
              paddingAll: 'md',
              contents: [
                { type: 'text', text: '💡 アドバイス', weight: 'bold', size: 'sm', color: '#ff9800' },
                { 
                  type: 'text', 
                  text: result.rank === 'A' 
                    ? '十分な予算余裕があります。立地やグレードにこだわった物件選びが可能です。' 
                    : (result.rank === 'B' ? '標準的な予算計画です。物件価格だけでなく、維持費も含めたトータルコストで判断しましょう。' : '少し予算の上限に近いため、エリアを見直すか、頭金を準備することでより安全な計画になります。'),
                  size: 'xs', 
                  color: '#555555',  
                  wrap: true, 
                  margin: 'sm', 
                  lineHeight: '1.6' 
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
               color: '#06C755',
               height: 'sm',
               action: {
                 type: 'uri',
                 label: '📅 来店・Web予約する',
                 uri: 'https://www.wintate.net/reservation/select/'
               }
             },
             {
               type: 'button',
               style: 'secondary',
               height: 'sm',
               action: {
                 type: 'uri',
                 label: '↻ 条件を変えて再診断',
                 uri: 'https://liff.line.me/2009124041-eKYG4I5Q'
               }
             },
             {
               type: 'button',
               style: 'link',
               height: 'sm',
               action: {
                 type: 'message',
                 label: '🤖 この条件でAIに相談',
                 text: `【AI相談】\n診断ID:${diagnosisId}\n判定:${zoneTitle}\n目安予算:${rangeText}\nこの結果について詳しく教えてください。`
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

// 共通ヘッダー定義（UsersシートとDiagnosisLogシートで共通）
const SHEET_HEADERS = [
  '診断ID', 'LINE', '温度感',
  '購入時期', '世帯年収', '雇用形態', '勤続年数',
  '既存借入', '現在の住まい', '家族構成', '将来の予定',
  '希望エリア', '物件タイプ', '譲れない条件', '不安なこと', '希望価格帯',
  '安全予算（万円）', '上限予算（万円）',
  '会話ID', '更新日時'
];

/**
 * データ行を生成（UsersとLogで共通）
 */
function buildRowData(userId, data) {
  const lineCell = data.userName ? `${userId} / ${data.userName}` : userId;
  return [
    data.diagnosisId || '',
    lineCell,
    data.heatLevel || '',
    data.q1Label || '',
    data.q2Label || '',
    data.q3Label || '',
    data.q4Label || '',
    data.q5Label || '',
    data.q6Label || '',
    data.q7Label || '',
    data.q8Label || '',
    data.q9Label || '',
    data.q10Label || '',
    data.q11Label || '',
    data.q12Label || '',
    data.q13Label || '',
    data.safeBudget || '',
    data.maxBudget || '',
    data.conversationId || '',
    new Date()
  ];
}

/**
 * ヘッダー自動補完
 */
function ensureHeaders(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < SHEET_HEADERS.length) {
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
  }
}

function getUserData(userId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) return null;
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0] || [];
  for (let i = 1; i < data.length; i++) {
    const lineCell = String(data[i][headers.indexOf('LINE')] || data[i][1]);
    if (lineCell.includes(userId)) {
      const row = {};
      headers.forEach((h, idx) => { row[h] = data[i][idx]; });
      return {
        userId: userId,
        annualIncome: row['世帯年収'] || '',
        targetArea: row['希望エリア'] || '',
        propertyType: row['物件タイプ'] || '',
        mustConditions: row['譲れない条件'] || '',
        familyStructure: row['家族構成'] || '',
        safeBudget: row['安全予算（万円）'] || '',
        maxBudget: row['上限予算（万円）'] || '',
        conversationId: row['会話ID'] || ''
      };
    }
  }
  return null;
}

function saveUserData(userId, data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) { sheet = ss.insertSheet(USERS_SHEET_NAME); }
  ensureHeaders(sheet);

  // 既存ユーザー検索
  const rows = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).includes(userId)) {
      rowIndex = i + 1;
      break;
    }
  }

  const rowData = buildRowData(userId, data);

  if (rowIndex > 0) {
    sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
}

const LOG_SHEET_NAME = 'DiagnosisLog';

function saveLogData(userId, data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) { sheet = ss.insertSheet(LOG_SHEET_NAME); }
  ensureHeaders(sheet);

  const rowData = buildRowData(userId, data);
  sheet.appendRow(rowData);
}

function saveUserConversationId(userId, conversationId) {
  const userData = getUserData(userId) || {};
  userData.conversationId = conversationId;
  saveUserData(userId, userData);
}

function getConversationId(userId) {
  const data = getUserData(userId);
  return data ? data.conversationId : null;
}
