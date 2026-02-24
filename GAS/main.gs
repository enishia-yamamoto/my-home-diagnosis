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
const DEFAULT_RATE_FLOATING = 1.0; // 変動金利 (%)
const DEFAULT_TERM_YEARS = 35;     // 返済期間 (年)

// ==========================================
// 2. APIハンドラ (Main)
// ==========================================

/**
 * 共通処理: OPTIONSリクエストへの対応 (CORSプリフライト用)
 */
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
    
    // リクエスト内容の確認
    if (e && e.postData) {
      console.log('ContentType:', e.postData.type);
      console.log('Contents:', e.postData.contents);
    } else {
      console.error('No postData received');
      return createJsonResponse({ status: 'error', message: 'No postData' });
    }

    let json;
    try {
      json = JSON.parse(e.postData.contents);
    } catch (error) {
      console.error('JSON Parse Error:', error);
      return createJsonResponse({ status: 'error', message: 'Invalid JSON' });
    }

    // 診断データ送信の場合
    if (json.type === 'diagnosis') {
      console.log('Processing Diagnosis API');
      return handleDiagnosisApi(json.data);
    }
  
    // LINE Webhookの場合
    if (json.events) {
      console.log('Processing LINE Webhook');
      return handleLineWebhook(json);
    }

    // どのタイプにもマッチしない場合
    if (json.userId) {
       console.log('Assuming flat diagnosis data based on userId');
       return handleDiagnosisApi(json);
    }

    console.warn('Unknown request type:', JSON.stringify(json));
    return createJsonResponse({ status: 'error', message: 'Unknown request type' });

  } catch (error) {
    console.error('Global Error in doPost:', error);
    return createJsonResponse({ status: 'error', message: error.toString() });
  }
}

/**
 * 診断API処理
 */
function parseDiagnosisData(raw) {
  const ans = raw.answers || {};
  
  // 年収の数値化（万円）- 範囲で取得
  let incomeMin = 0;
  let incomeMax = 0;
  if (ans.q2) {
    if (ans.q2.value === 'MANUAL') {
      const v = Number(ans.q2.extra);
      incomeMin = v;
      incomeMax = v;
    } else {
      const incomeMap = {
        'LT_400': {min:200, max:399}, '400_600': {min:400, max:599},
        '600_800': {min:600, max:799}, '800_1000': {min:800, max:999},
        'GT_1000': {min:1000, max:1500}
      };
      const range = incomeMap[ans.q2.value];
      incomeMin = range ? range.min : 0;
      incomeMax = range ? range.max : 0;
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

  // 年齢 (Q14)
  let age = 35; // デフォルト
  if (ans.q14) {
    if (ans.q14.value === 'MANUAL' && ans.q14.extra) {
      age = Number(ans.q14.extra);
    } else {
      const ageMap = { 'AGE_20S': 25, 'AGE_30S': 35, 'AGE_40S': 45, 'AGE_50S': 55 };
      age = ageMap[ans.q14.value] || 35;
    }
  }

  // 頭金 (Q15) - 万円単位
  let capital = 0;
  if (ans.q15 && ans.q15.value === 'EXISTS' && ans.q15.extra) {
    capital = Number(ans.q15.extra);
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
    heatLevel: ({ high: '高', mid: '中', low: '低' })[raw.heatLevel] || raw.heatLevel,
    // 計算用数値（範囲）
    annualIncomeMin: incomeMin,
    annualIncomeMax: incomeMax,
    monthlyDebt: debt,
    currentRent: rent,
    ownCapital: capital,
    age: age,
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
    // Q14: 年齢（手動入力の場合はextraも付ける）
    q14Label: (ans.q14 && ans.q14.value === 'MANUAL' && ans.q14.extra) ? `${ans.q14.extra}歳` : label('q14'),
    // Q15: 頭金（ありの場合はextraも付ける）
    q15Label: (ans.q15 && ans.q15.extra) ? `${label('q15')}（${Number(ans.q15.extra).toLocaleString()}万円）` : label('q15'),
    // その他
    targetArea: area,
    propertyType: ans.q10 ? ans.q10.label : '',
    mustConditions: ans.q11 ? ans.q11.label : '',
    rawAnswers: ans
  };
}

/**
 * 診断ID生成（mon-MMDD-XXX 形式、月英略称+日付+ランダム英数3桁）
 */
function generateDiagnosisId() {
  const now = new Date();
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const mon = monthNames[now.getMonth()];
  const d = String(now.getDate()).padStart(2, '0');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rand = '';
  for (let i = 0; i < 3; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${now.getFullYear()}-${mon.charAt(0).toUpperCase() + mon.slice(1)}${d}-${rand}`;
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
      conversationId: '',  // 再診断時はDify会話をリセット（新しいinputsを反映させるため）
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
      q13Label: parsedData.q13Label,
      q14Label: parsedData.q14Label,
      q15Label: parsedData.q15Label
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

  // 計算用定数 (未設定時はデフォルト値)
  get rateFloating() { return Number(this.get('RATE_FLOATING')) || DEFAULT_RATE_FLOATING; }
  get termYears() { return Number(this.get('TERM_YEARS')) || DEFAULT_TERM_YEARS; }
}

function getConfig() { return new Config(); }

// ==========================================
// 3. 予算計算ロジック (Calculator)
// ==========================================
class Calculator {
  constructor(config) { this.config = config; }

  pv(rate, periods, payment) {
    if (rate === 0) return payment * periods;
    const monthlyRate = rate / 12;
    return payment * (1 - Math.pow(1 + monthlyRate, -periods)) / monthlyRate;
  }

  calculateAll(input) {
    const incomeMin = Number(input.annualIncomeMin); // 万円（下限）
    const incomeMax = Number(input.annualIncomeMax); // 万円（上限）
    const capital = Number(input.ownCapital);   // 万円（頭金）
    const debt = Number(input.monthlyDebt) || 0; // 円（月々の既存借入返済額）
    const rate = this.config.rateFloating / 100; // 年利（小数）

    // --- ③ 年齢による返済期間調整 ---
    const age = Number(input.age) || 35;
    const maxCompletionAge = 80;
    const actualYears = Math.min(this.config.termYears, maxCompletionAge - age);
    const months = Math.max(actualYears, 1) * 12;

    // --- 返済比率の決定 ---
    const empType = (input.rawAnswers && input.rawAnswers.q3) ? input.rawAnswers.q3.value : '';

    const getRatioMax = (income) => {
      if (empType === 'PUBLIC') return 0.40;
      if (income < 400) return 0.30;
      return 0.35;
    };
    const ratioSafe = 0.20; // 安全ゾーン: 常に20%

    // --- ① 勤続年数による補正係数 ---
    const tenureValue = (input.rawAnswers && input.rawAnswers.q4) ? input.rawAnswers.q4.value : '';
    const tenureFactor = (tenureValue === 'LT_1Y') ? 0.7 : 1.0;

    // --- 下限年収での計算 ---
    const ratioMaxMin = getRatioMax(incomeMin);
    let maxMonthlyMin = (incomeMin * 10000 * ratioMaxMin) / 12;
    // ② 既存借入の差し引き
    maxMonthlyMin = Math.max(maxMonthlyMin - debt, 0);
    let maxLoanMin = this.pv(rate, months, maxMonthlyMin);
    // ① 勤続年数補正
    maxLoanMin = maxLoanMin * tenureFactor;
    const maxBudgetMin = Math.floor((maxLoanMin + capital * 10000) / 10000);

    let safeMonthlyMin = (incomeMin * 10000 * ratioSafe) / 12;
    safeMonthlyMin = Math.max(safeMonthlyMin - debt, 0);
    let safeLoanMin = this.pv(rate, months, safeMonthlyMin);
    safeLoanMin = safeLoanMin * tenureFactor;
    const safeBudgetMin = Math.floor((safeLoanMin + capital * 10000) / 10000);

    // --- 上限年収での計算 ---
    const ratioMaxMax = getRatioMax(incomeMax);
    let maxMonthlyMax = (incomeMax * 10000 * ratioMaxMax) / 12;
    maxMonthlyMax = Math.max(maxMonthlyMax - debt, 0);
    let maxLoanMax = this.pv(rate, months, maxMonthlyMax);
    maxLoanMax = maxLoanMax * tenureFactor;
    const maxBudgetMax = Math.floor((maxLoanMax + capital * 10000) / 10000);

    let safeMonthlyMax = (incomeMax * 10000 * ratioSafe) / 12;
    safeMonthlyMax = Math.max(safeMonthlyMax - debt, 0);
    let safeLoanMax = this.pv(rate, months, safeMonthlyMax);
    safeLoanMax = safeLoanMax * tenureFactor;
    const safeBudgetMax = Math.floor((safeLoanMax + capital * 10000) / 10000);

    // ランク判定（保守的 = 下限ベース）
    let rank = 'B';
    const desired = input.desiredBudget;

    if (maxBudgetMax === 0 && safeBudgetMax === 0) {
      rank = 'C'; // 借入不可の場合は問答無用でC
    } else if (desired > 0) {
      if (desired <= safeBudgetMin) {
        rank = 'A'; // 下限年収でも安全圏
      } else if (desired > maxBudgetMax) {
        rank = 'C'; // 上限年収でも超過
      } else {
        rank = 'B'; // 検討圏
      }
    }

    // 月々の返済目安
    const calcMonthly = (loanAmount, r, m) => {
      if (loanAmount <= 0 || r <= 0) return 0;
      const mr = r / 12;
      return Math.round(loanAmount * mr * Math.pow(1 + mr, m) / (Math.pow(1 + mr, m) - 1));
    };
    // 上限予算ベース
    const monthlyPaymentMin = calcMonthly(maxLoanMin, rate, months);
    const monthlyPaymentMax = calcMonthly(maxLoanMax, rate, months);
    // 安全予算ベース
    const safeMonthlyPaymentMin = calcMonthly(safeLoanMin, rate, months);
    const safeMonthlyPaymentMax = calcMonthly(safeLoanMax, rate, months);

    // 範囲文字列を生成（表示・保存用）
    const safeBudgetText = (safeBudgetMin === safeBudgetMax)
      ? `${safeBudgetMin}` : `${safeBudgetMin}〜${safeBudgetMax}`;
    const maxBudgetText = (maxBudgetMin === maxBudgetMax)
      ? `${maxBudgetMin}` : `${maxBudgetMin}〜${maxBudgetMax}`;
    const fmtM = (v) => (v / 10000).toFixed(1);
    const monthlyPaymentText = (monthlyPaymentMin === monthlyPaymentMax)
      ? `約${fmtM(monthlyPaymentMin)}万円` : `約${fmtM(monthlyPaymentMin)}〜${fmtM(monthlyPaymentMax)}万円`;

    return {
      userId: input.userId,
      userName: input.userName,
      currentRent: input.currentRent,
      propertyType: input.propertyType,
      targetArea: input.targetArea,
      mustConditions: input.mustConditions,
      maxBudget: maxBudgetText,
      safeBudget: safeBudgetText,
      safeBudgetMin: safeBudgetMin,
      safeBudgetMax: safeBudgetMax,
      maxBudgetMin: maxBudgetMin,
      maxBudgetMax: maxBudgetMax,
      monthlyPaymentMin: monthlyPaymentMin,
      monthlyPaymentMax: monthlyPaymentMax,
      safeMonthlyPaymentMin: safeMonthlyPaymentMin,
      safeMonthlyPaymentMax: safeMonthlyPaymentMax,
      monthlyPaymentText: monthlyPaymentText,
      actualYears: actualYears,
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
        console.error('Payload:', JSON.stringify({ to: userId, messages: messages }));
      } else {
        console.log('LINE Push Success');
      }
    } catch (e) {
      console.error('LINE Push Error:', e);
      console.error('Payload:', JSON.stringify({ to: userId, messages: messages }));
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

    // --- ヘッダータイトル ---
    let headerTitle = 'ゆとりのある予算計画です✨';
    if (result.rank === 'B') headerTitle = '標準的な予算計画です';
    else if (result.rank === 'C') headerTitle = '予算超過の可能性があります';

    // --- 金額表示ヘルパー ---
    const roundBudget = (amount) => Math.floor(amount / 100) * 100;
    const fmtMan = (v) => `約 ${roundBudget(v).toLocaleString()}万円`;
    const rangeMan = (min, max) => (min === max)
      ? fmtMan(min)
      : `約 ${roundBudget(min).toLocaleString()}万円 〜 ${roundBudget(max).toLocaleString()}万円`;

    // 月々返済目安（円→万円で表示、小数1桁）
    const fmtMonthly = (v) => {
      const man = v / 10000;
      return `約 ${man.toFixed(1)}万円`;
    };
    const monthlyText = (result.monthlyPaymentMin === result.monthlyPaymentMax)
      ? fmtMonthly(result.monthlyPaymentMin)
      : `${fmtMonthly(result.monthlyPaymentMin)} 〜 ${fmtMonthly(result.monthlyPaymentMax)}`;

    // 安全ライン月々返済目安
    const safeMonthlyText = (result.safeMonthlyPaymentMin === result.safeMonthlyPaymentMax)
      ? fmtMonthly(result.safeMonthlyPaymentMin)
      : `${fmtMonthly(result.safeMonthlyPaymentMin)} 〜 ${fmtMonthly(result.safeMonthlyPaymentMax)}`;

    // 家賃差額（家賃入力時のみ表示）
    const rentDiffContents = [];
    const rent = result.currentRent || 0; // 円単位
    if (rent > 0) {
      const diffMin = result.safeMonthlyPaymentMin - rent;
      const diffMax = result.safeMonthlyPaymentMax - rent;
      const fmtDiff = (v) => `約${(Math.abs(v) / 10000).toFixed(1)}万円`;
      let diffText = '';
      let diffColor = '#333333';
      if (diffMin >= 0 && diffMax >= 0) {
        // 両方増
        diffText = (diffMin === diffMax)
          ? `現在の家賃より ${fmtDiff(diffMin)} 増`
          : `現在の家賃より ${fmtDiff(diffMin)} 〜 ${fmtDiff(diffMax)} 増`;
        diffColor = '#E53935';
      } else if (diffMin < 0 && diffMax < 0) {
        // 両方減
        diffText = (diffMin === diffMax)
          ? `現在の家賃より ${fmtDiff(diffMin)} 減`
          : `現在の家賃より ${fmtDiff(diffMax)} 〜 ${fmtDiff(diffMin)} 減`;
        diffColor = '#2e7d32';
      } else {
        // 跨ぐ場合
        diffText = `現在の家賃より ${fmtDiff(diffMin)}減 〜 ${fmtDiff(diffMax)}増`;
        diffColor = '#FF9800';
      }
      rentDiffContents.push(
        { type: 'text', text: `（現在の家賃: 約${(rent / 10000).toFixed(1)}万円）`, size: 'xxs', color: '#888888', align: 'center', margin: 'xs' },
        { type: 'text', text: diffText, size: 'xs', weight: 'bold', color: diffColor, align: 'center', margin: 'xs' }
      );
    }

    // 借入可能額
    const maxBudgetRange = rangeMan(result.maxBudgetMin, result.maxBudgetMax);
    // 安全予算
    const safeBudgetRange = rangeMan(result.safeBudgetMin, result.safeBudgetMax);

    // 診断ID
    const diagnosisId = result.diagnosisId || '';

    // 返済期間注釈（35年未満の場合のみ表示）
    const actualYears = result.actualYears || 35;
    const termNoteContents = [];
    if (actualYears < 35) {
      termNoteContents.push(
        { type: 'text', text: `※返済期間${actualYears}年（完済時80歳）で計算`, size: 'xxs', color: '#888888', align: 'center', margin: 'sm' }
      );
    }

    // --- ランク別アドバイス文 ---
    let adviceLines = [];
    if (result.rank === 'A') {
      adviceLines = [
        'この範囲であれば、',
        '将来の支出増加にも比較的対応しやすい水準です。'
      ];
    } else if (result.rank === 'B') {
      adviceLines = [
        'ご希望条件によっては、',
        '借入上限に近づく可能性があります。',
        '',
        '物件価格だけでなく、',
        '固定資産税・修繕費・将来の教育費なども含めて',
        '総合的に判断することが大切です。'
      ];
    } else {
      adviceLines = [
        '現在のご希望条件では、',
        '借入上限に近い可能性があります。',
        '',
        'より安全に進めるためには、',
        '・エリアの見直し',
        '・購入価格の調整',
        '・頭金の準備',
        '・既存借入の整理',
        '・住宅ローン契約時に完済できる借入の確認',
        '',
        'などを検討すると安心です。'
      ];
    }

    // --- ランク別CTAボタン ---
    const btnPro = (label) => ({
      type: 'button', style: 'primary', color: '#06C755', height: 'sm',
      action: { type: 'uri', label: label, uri: 'https://www.wintate.net/reservation/select/' }
    });
    const btnRediagnose = {
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'uri', label: '↻ 条件を変えて再診断する', uri: 'https://liff.line.me/2009124041-eKYG4I5Q' }
    };
    const btnAI = (label, msg) => ({
      type: 'button', style: 'link', height: 'sm',
      action: { type: 'message', label: label, text: msg }
    });

    let footerButtons = [];
    if (result.rank === 'A') {
      footerButtons = [
        btnPro('▶ この条件で具体的にプロに相談する'),
        btnRediagnose,
        btnAI('▶ この条件でAIに詳しく相談する', 'この条件で具体的に相談したいです。')
      ];
    } else if (result.rank === 'B') {
      footerButtons = [
        btnPro('▶ 安全な進め方をプロに相談する'),
        btnRediagnose,
        btnAI('▶ この条件でAIに相談する', '安全な住宅購入の進め方を相談したいです。')
      ];
    } else {
      footerButtons = [
        { type: 'button', style: 'primary', color: '#06C755', height: 'sm',
          action: { type: 'message', label: '▶ 改善ポイントをAIに相談する', text: '予算を改善するためのポイントを教えてください。' } },
        btnRediagnose,
        { type: 'button', style: 'link', height: 'sm',
          action: { type: 'uri', label: '▶ 安全な進め方をプロに相談する', uri: 'https://www.wintate.net/reservation/select/' } }
      ];
    }

    // --- 注釈テキスト ---
    const disclaimerTexts = [
      `※借入期間${actualYears}年・金利1.0％で試算した概算です。`,
      '※既存借入の延滞等がない前提で算出しています。',
      '※金融機関の審査結果を保証するものではありません。'
    ];

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
              type: 'box', layout: 'horizontal', margin: 'md',
              contents: [
                { type: 'text', text: `あなたの診断ID: ${diagnosisId}`, color: '#ffffffcc', size: 'xs' }
              ],
              paddingTop: 'sm', borderWidth: 'normal', borderColor: '#ffffff44',
              paddingStart: 'none', paddingEnd: 'none', paddingBottom: 'none'
            }
          ],
          backgroundColor: color,
          paddingAll: 'xl'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            // --- 想定借入可能額 ---
            { type: 'text', text: '現在のご年収から見た', size: 'xs', color: '#888888', margin: 'lg', align: 'center' },
            { type: 'text', text: '想定借入可能額の目安', size: 'sm', color: '#333333', weight: 'bold', align: 'center', margin: 'xs' },
            {
              type: 'box', layout: 'vertical', margin: 'sm',
              backgroundColor: '#f0f0f0', cornerRadius: '8px', paddingAll: 'md',
              contents: [
                { type: 'text', text: maxBudgetRange, size: 'lg', weight: 'bold', color: color, align: 'center' }
              ]
            },

            // --- 月々の返済目安 ---
            { type: 'text', text: '月々の返済目安', size: 'xs', color: '#888888', margin: 'lg', align: 'center' },
            {
              type: 'box', layout: 'vertical', margin: 'xs',
              contents: [
                { type: 'text', text: monthlyText, size: 'md', weight: 'bold', color: '#333333', align: 'center' }
              ]
            },

            // --- 区切り線 ---
            {
              type: 'separator', margin: 'xl', color: '#e0e0e0'
            },

            // --- 生活安全ラインの目安 ---
            { type: 'text', text: '生活安全ラインの目安', size: 'sm', color: '#333333', weight: 'bold', margin: 'xl', align: 'center' },
            { type: 'text', text: '無理のない範囲で検討できる金額', size: 'xs', color: '#888888', align: 'center', margin: 'xs' },
            {
              type: 'box', layout: 'vertical', margin: 'sm',
              backgroundColor: '#e8f5e9', cornerRadius: '8px', paddingAll: 'md',
              contents: [
                { type: 'text', text: safeBudgetRange, size: 'lg', weight: 'bold', color: '#2e7d32', align: 'center' }
              ]
            },

            // --- 安全ライン 月々の返済目安 ---
            { type: 'text', text: '月々の返済目安', size: 'xs', color: '#888888', margin: 'lg', align: 'center' },
            {
              type: 'box', layout: 'vertical', margin: 'xs',
              contents: [
                { type: 'text', text: safeMonthlyText, size: 'md', weight: 'bold', color: '#2e7d32', align: 'center' }
              ]
            },
            // --- 家賃差額（家賃入力時のみ） ---
            ...(rentDiffContents),
            // --- 返済期間注釈（35年未満の場合のみ） ---
            ...(termNoteContents),

            // --- ランク別アドバイス ---
            {
              type: 'box', layout: 'vertical', margin: 'xl',
              backgroundColor: result.rank === 'A' ? '#e8f5e9' : (result.rank === 'B' ? '#fff3e0' : '#ffebee'),
              cornerRadius: '8px', paddingAll: 'md',
              contents: adviceLines.filter(line => line !== '').map(line =>
                  ({ type: 'text', text: line, size: 'xs', color: '#555555', wrap: true, lineHeight: '1.6' })
              )
            },

            // --- 注釈 ---
            {
              type: 'box', layout: 'vertical', margin: 'lg',
              contents: disclaimerTexts.map(t =>
                ({ type: 'text', text: t, size: 'xxs', color: '#aaaaaa', wrap: true })
              )
            }
          ]
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            ...footerButtons
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
    this.apiUrl = 'https://api.dify.ai/v1';
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
      return '現在、システムが応答できません。（管理者へ：GASの実行ログを確認してください）';
    }
  }

  chatWithDiagnosis(userId, query, diagnosis, conversationId) {
    // ランクはスプシから取得（保存済み）
    const rank = diagnosis.rank || 'B';

    return this.chat(userId, query, {
      heat_level: String(diagnosis.heatLevel || ''),
      purchase_timing: String(diagnosis.q1Label || ''),
      income: String(diagnosis.income || ''),
      employment_type: String(diagnosis.q3Label || ''),
      years_employed: String(diagnosis.q4Label || ''),
      existing_loans: String(diagnosis.q5Label || ''),
      current_housing: String(diagnosis.q6Label || ''),
      family: String(diagnosis.family || ''),
      future_plans: String(diagnosis.q8Label || ''),
      area: String(diagnosis.area || ''),
      property_type: String(diagnosis.propertyType || ''),
      conditions: String(diagnosis.conditions || ''),
      concerns: String(diagnosis.concerns || ''),
      desired_budget: String(diagnosis.desiredBudget || ''),
      age: String(diagnosis.q14Label || ''),
      down_payment: String(diagnosis.q15Label || ''),
      safe_budget: String(diagnosis.safeBudget || ''),
      max_budget: String(diagnosis.maxBudget || ''),
      monthly_payment: String(diagnosis.monthlyPaymentText || ''),
      rank: rank
    }, conversationId);
  }
}

// ==========================================
// 6. ユーザーデータ管理 (Users / DiagnosisLog Sheet)
// ==========================================
const USERS_SHEET_NAME = 'Users';

// 共通ヘッダー定義（UsersシートとDiagnosisLogシートで共通）
const SHEET_HEADERS = [
  '診断ID', 'LINE ID', 'ニックネーム', '温度感',
  '購入時期', '世帯年収', '雇用形態', '勤続年数',
  '既存借入', '現在の住まい', '家族構成', '将来の予定',
  '希望エリア', '物件タイプ', '譲れない条件', '不安なこと', '希望価格帯',
  '年齢', '頭金',
  '安全予算（万円）', '上限予算（万円）', '月々返済目安', '返済期間', '判定ランク',
  '会話ID', '更新日時'
];

/**
 * データ行を生成（UsersとLogで共通）
 */
function buildRowData(userId, data) {
  return [
    data.diagnosisId || '',
    userId,
    data.userName || '',
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
    data.q14Label || '',
    data.q15Label || '',
    data.safeBudget || '',
    data.maxBudget || '',
    data.monthlyPaymentText || '',
    data.actualYears ? `${data.actualYears}年` : '',
    data.rank || '',
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
    const lineIdCol = headers.indexOf('LINE ID');
    const lineId = String(data[i][lineIdCol >= 0 ? lineIdCol : 1]);
    if (lineId === userId) {
      const row = {};
      headers.forEach((h, idx) => { row[h] = data[i][idx]; });
      return {
        userId: userId,
        heatLevel: row['温度感'] || '',
        income: row['世帯年収'] || '',
        family: row['家族構成'] || '',
        area: row['希望エリア'] || '',
        propertyType: row['物件タイプ'] || '',
        conditions: row['譲れない条件'] || '',
        concerns: row['不安なこと'] || '',
        desiredBudget: row['希望価格帯'] || '',
        safeBudget: row['安全予算（万円）'] || '',
        maxBudget: row['上限予算（万円）'] || '',
        rank: row['判定ランク'] || '',
        conversationId: row['会話ID'] || '',
        // buildRowData互換フィールド（saveUserConversationId経由での上書き防止用）
        diagnosisId: row['診断ID'] || '',
        userName: row['ニックネーム'] || '',
        q1Label: row['購入時期'] || '',
        q2Label: row['世帯年収'] || '',
        q3Label: row['雇用形態'] || '',
        q4Label: row['勤続年数'] || '',
        q5Label: row['既存借入'] || '',
        q6Label: row['現在の住まい'] || '',
        q7Label: row['家族構成'] || '',
        q8Label: row['将来の予定'] || '',
        q9Label: row['希望エリア'] || '',
        q10Label: row['物件タイプ'] || '',
        q11Label: row['譲れない条件'] || '',
        q12Label: row['不安なこと'] || '',
        q13Label: row['希望価格帯'] || '',
        q14Label: row['年齢'] || '',
        q15Label: row['頭金'] || ''
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
    if (String(rows[i][1]) === userId) {
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  const headers = data[0] || [];
  const convCol = headers.indexOf('会話ID');
  if (convCol < 0) return;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === userId) {
      sheet.getRange(i + 1, convCol + 1).setValue(conversationId);
      return;
    }
  }
}

function getConversationId(userId) {
  const data = getUserData(userId);
  return data ? data.conversationId : null;
}
