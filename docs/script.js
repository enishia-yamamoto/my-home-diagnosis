const LIFF_ID = '2009124041-eKYG4I5Q';
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzp_Mdg5MQ4e6JUVW4nIN3eCazr0d5m7Yba3p3OntKeryzCkuXT5MymBaClvOhYygFPaQ/exec'; // Keep existing URL

// State
let currentStep = 0;
let answers = {};
let heatLevel = 'high'; // 'high' | 'mid' | 'low'
let questionQueue = []; // Array of Question IDs to ask

// Question Definitions
const QUESTIONS = {
    q1: {
        id: 'q1',
        text: '購入したい時期は？',
        type: 'radio',
        options: [
            { label: 'すぐ', value: 'IMMEDIATE', heat: 'high' },
            { label: '半年以内', value: 'WITHIN_6M', heat: 'mid' },
            { label: '1年～2年以内', value: 'WITHIN_2Y', heat: 'low' },
            { label: 'それ以上', value: 'OVER_2Y', heat: 'low' }
        ]
    },
    q2: {
        id: 'q2',
        text: '世帯年収 (ローンの審査対象者)',
        type: 'radio-with-input',
        options: [
            { label: '〜399万', value: 'LT_400' },
            { label: '400〜599万', value: '400_600' },
            { label: '600〜799万', value: '600_800' },
            { label: '800〜999万', value: '800_1000' },
            { label: '1,000万以上', value: 'GT_1000' },
            { label: '任意入力', value: 'MANUAL', input: true }
        ],
        inputType: 'number',
        inputPlaceholder: '例: 550'
    },
    q3: {
        id: 'q3',
        text: '雇用形態',
        type: 'radio',
        options: [
            { label: '正社員', value: 'REGULAR' },
            { label: '公務員', value: 'PUBLIC' },
            { label: '自営業', value: 'SELF' },
            { label: '契約/派遣', value: 'CONTRACT' }
        ]
    },
    q4: {
        id: 'q4',
        text: '勤続年数',
        type: 'radio',
        options: [
            { label: '1年未満', value: 'LT_1Y' },
            { label: '1〜3年', value: '1Y_3Y' },
            { label: '3〜5年', value: '3Y_5Y' },
            { label: '5年以上', value: 'GT_5Y' }
        ]
    },
    q5: {
        id: 'q5',
        text: '既存借入の有無',
        type: 'radio-conditional-input',
        options: [
            { label: '借入なし', value: 'NONE' },
            { label: '借入あり（車）', value: 'EXISTS_CAR', showInput: true },
            { label: '借入あり（カード・その他）', value: 'EXISTS_OTHER', showInput: true }
        ],
        inputLabel: '月々の返済合計',
        inputType: 'number',
        inputPlaceholder: '例: 30000',
        inputUnit: '円'
    },
    q6: {
        id: 'q6',
        text: '現在の住まい',
        type: 'radio-conditional-input',
        options: [
            { label: '賃貸', value: 'RENT', showInput: true },
            { label: '持ち家', value: 'OWNED' },
            { label: '実家', value: 'PARENTS' },
            { label: '社宅', value: 'COMPANY' }
        ],
        inputLabel: '現在の家賃',
        inputType: 'number',
        inputPlaceholder: '例: 80000',
        inputUnit: '円'
    },
    q7: {
        id: 'q7',
        text: '家族構成',
        type: 'radio',
        options: [
            { label: '単身', value: 'SINGLE' },
            { label: '夫婦', value: 'COUPLE' },
            { label: '夫婦＋子1人', value: 'COUPLE_1CHILD' },
            { label: '夫婦＋子2人以上', value: 'COUPLE_2CHILD' },
            { label: '二世帯', value: '2GEN' }
        ]
    },
    q8: {
        id: 'q8',
        text: '将来の予定（複数選択可）',
        type: 'checkbox',
        options: [
            { label: '子供予定あり', value: 'PLAN_CHILD' },
            { label: '転職予定あり', value: 'PLAN_JOB_CHANGE' },
            { label: '共働き予定', value: 'PLAN_DUAL_WORK' },
            { label: '未定', value: 'UNDECIDED' }
        ]
    },
    q9: {
        id: 'q9',
        text: '希望エリア',
        type: 'area-select'
        // Logic handled in renderer
    },
    q10: {
        id: 'q10',
        text: '希望の物件タイプ',
        type: 'radio',
        options: [
            { label: '注文住宅', value: 'CUSTOM' },
            { label: '建売', value: 'BUILT' },
            { label: '中古', value: 'USED' },
            { label: 'まだ決めていない', value: 'UNDECIDED' }
        ]
    },
    q11: {
        id: 'q11',
        text: '譲れない条件（複数選択）',
        type: 'checkbox',
        options: [
            { label: '駐車場2台', value: 'PARKING_2' },
            { label: '学区', value: 'SCHOOL_DIST' },
            { label: '駅距離', value: 'STATION_DIST' },
            { label: '庭', value: 'GARDEN' },
            { label: '断熱性能', value: 'INSULATION' },
            { label: '価格重視', value: 'PRICE' }
        ]
    },
    q12: {
        id: 'q12',
        text: '住宅購入で一番不安なことは？',
        type: 'radio',
        options: [
            { label: 'ローン審査', value: 'LOAN_CHECK' },
            { label: '月々の支払い', value: 'MONTHLY_PAYMENT' },
            { label: '将来の収入', value: 'FUTURE_INCOME' },
            { label: '物件選び', value: 'OBJECT_SELECTION' },
            { label: '売却リスク', value: 'RESALE_RISK' }
        ]
    },
    q13: {
        id: 'q13',
        text: '希望購入価格帯',
        type: 'radio',
        options: [
            { label: '2,000万以下', value: 'LT_2000' },
            { label: '2,000〜3,000万', value: '2000_3000' },
            { label: '3,000〜4,000万', value: '3000_4000' },
            { label: '4,000万以上', value: 'GT_4000' },
            { label: 'わからない', value: 'UNKNOWN' }
        ]
    }
};

// Flow Definitions based on Heat
const FLOWS = {
    high: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11', 'q12', 'q13'],
    mid: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q12', 'q13'],
    low: ['q1', 'q2', 'q3', 'q4', 'q5', 'q9']
};

/* Prefecture Data */
const PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"
];


// Initialization
window.onload = async function () {
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) {
        liff.login();
    }
    renderStartScreen();
};

function renderStartScreen() {
    const app = document.getElementById('app-content');
    app.innerHTML = `
        <div class="intro-screen">
            <h1>🏠 マイホーム適正予算診断</h1>
            <p>3分であなたの適正予算と<br>おすすめプランを診断します。</p>
            <div class="note">※個人情報は入力不要です</div>
            <button class="btn-primary" onclick="startDiagnosis()">診断を始める</button>
        </div>
    `;
}

function startDiagnosis() {
    currentStep = 0;
    answers = {};
    // Load Q1
    showQuestion('q1');
}

function showQuestion(qId) {
    const q = QUESTIONS[qId];
    const app = document.getElementById('app-content');

    // Progress Bar
    let progress = 0;
    if (questionQueue.length > 0) {
        progress = Math.round(((currentStep + 1) / questionQueue.length) * 100);
    } else if (qId === 'q1') {
        progress = 5;
    }

    let html = `
        <div class="progress-bar-container">
            <div class="progress-bar" style="width: ${progress}%"></div>
        </div>
        <div class="question-card fade-in">
            <div class="question-header">
                <span class="q-badge">Q${currentStep + 1}</span>
                <h2>${q.text}</h2>
            </div>
            <div class="question-body">
    `;

    // Render Options
    if (q.type === 'radio' || q.type === 'radio-with-input' || q.type === 'radio-conditional-input') {
        html += '<div class="options-list">';
        q.options.forEach((opt, idx) => {
            html += `
                <label class="option-item">
                    <input type="radio" name="answer" value="${opt.value}" 
                        onchange="handleRadioChange('${q.id}', '${opt.value}', ${opt.input || opt.showInput})">
                    <span class="option-label">${opt.label}</span>
                </label>
            `;
        });
        html += '</div>';

        // Conditional Input Area (Hidden by default)
        if (q.type === 'radio-with-input' || q.type === 'radio-conditional-input') {
            html += `
                <div id="conditionalInput" class="conditional-input hidden">
                    <label>${q.inputLabel || ''}</label>
                    <div class="input-wrapper">
                        <input type="${q.inputType || 'text'}" id="manualInput" placeholder="${q.inputPlaceholder || ''}">
                        <span class="unit">${q.inputUnit || '万円'}</span>
                    </div>
                </div>
            `;
        }
    } else if (q.type === 'checkbox') {
        html += '<div class="options-list">';
        q.options.forEach((opt) => {
            html += `
                <label class="option-item">
                    <input type="checkbox" name="answer" value="${opt.value}">
                    <span class="option-label">${opt.label}</span>
                </label>
            `;
        });
        html += '</div>';
    } else if (q.type === 'area-select') {
        html += `
            <div class="form-group">
                <label>都道府県</label>
                <select id="prefSelect" onchange="enableCitySelect()">
                    <option value="">選択してください</option>
                    ${PREFECTURES.map(p => `<option value="${p}">${p}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>市区町村 (任意)</label>
                <input type="text" id="cityInput" placeholder="例: つくば市">
            </div>
        `;
    }

    // Navigation
    const showBack = currentStep > 0;
    html += `
            </div>
            <div class="action-area">
                ${showBack ? '<button class="btn-secondary" onclick="goBack()">← 戻る</button>' : ''}
                <button class="btn-primary" onclick="submitAnswer('${qId}')">次へ</button>
            </div>
        </div>
    `;

    app.innerHTML = html;
}

function goBack() {
    if (currentStep > 0) {
        currentStep--;
        showQuestion(questionQueue[currentStep]);
    }
}

function handleRadioChange(qId, value, showInput) {
    const inputArea = document.getElementById('conditionalInput');
    if (!inputArea) return;

    if (showInput) {
        inputArea.classList.remove('hidden');
        setTimeout(() => document.getElementById('manualInput').focus(), 100);
    } else {
        inputArea.classList.add('hidden');
    }
}

async function submitAnswer(qId) {
    const q = QUESTIONS[qId];
    let answerValue = null;
    let extraInput = null;

    if (q.type.includes('radio')) {
        const selected = document.querySelector('input[name="answer"]:checked');
        if (!selected) {
            alert('選択してください');
            return;
        }
        answerValue = selected.value;

        // Handle input if visible
        const inputArea = document.getElementById('conditionalInput');
        if (inputArea && !inputArea.classList.contains('hidden')) {
            const val = document.getElementById('manualInput').value;
            if (!val) {
                alert('数値を入力してください');
                return;
            }
            extraInput = val;
        }

        // Q1 Logic: Determine Heat & Queue
        if (qId === 'q1') {
            const selectedOpt = q.options.find(o => o.value === answerValue);
            heatLevel = selectedOpt.heat;
            questionQueue = [...FLOWS[heatLevel]]; // Clone
            console.log('Heat Level:', heatLevel, 'Queue:', questionQueue);
        }

    } else if (q.type === 'checkbox') {
        const checked = document.querySelectorAll('input[name="answer"]:checked');
        /* // Allow skip if needed, but usually diagnosis needs some input. 
           // For "Conditions" (Q11), maybe optional? Let's require at least one or make "None" option. 
           // User didn't specify strict validation, but Q8 "Undecided" exists.
           // Let's assume blank is allowed for checkboxes if user just clicks Next? 
           // No, user experience suggests validation is better unless "Next" implies "None".
        */
        answerValue = Array.from(checked).map(c => c.value);
    } else if (q.type === 'area-select') {
        const pref = document.getElementById('prefSelect').value;
        const city = document.getElementById('cityInput').value;
        if (!pref) {
            alert('都道府県を選択してください');
            return;
        }
        answerValue = { pref, city };
    }

    // Save Answer
    answers[qId] = {
        value: answerValue,
        extra: extraInput,
        label: getLabel(qId, answerValue)
    };

    // Next Step
    currentStep++;
    if (currentStep < questionQueue.length) {
        showQuestion(questionQueue[currentStep]);
    } else {
        finishDiagnosis();
    }
}

function getLabel(qId, value) {
    const q = QUESTIONS[qId];
    if (q.type === 'area-select') return `${value.pref} ${value.city}`;
    if (Array.isArray(value)) { // checkbox
        return value.map(v => {
            const opt = q.options.find(o => o.value === v);
            return opt ? opt.label : v;
        }).join(', ');
    }
    const opt = q.options.find(o => o.value === value);
    return opt ? opt.label : value;
}

function finishDiagnosis() {
    const app = document.getElementById('app-content');
    app.innerHTML = `
        <div class="overlay">
            <div class="spinner"></div>
            <p>診断結果を作成中...</p>
        </div>
    `;

    // Send to GAS
    sendToGas(answers);
}

async function sendToGas(data) {
    const profile = await liff.getProfile();
    const payload = {
        userId: profile.userId,
        userName: profile.displayName, // Optional
        answers: data,
        heatLevel: heatLevel,
        timestamp: new Date().toISOString()
    };

    // Use no-cors for GAS
    fetch(GAS_API_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    }).then(() => {
        // Assume success
        document.getElementById('app-content').innerHTML = `
            <div class="complete-content">
                <div class="icon">✅</div>
                <h2>診断完了！</h2>
                <p>LINEのトーク画面に<br>結果を送信しました。</p>
                <button class="btn-secondary" onclick="liff.closeWindow()">閉じる</button>
            </div>
        `;
    }).catch(err => {
        alert('送信エラー: ' + err);
    });
}
