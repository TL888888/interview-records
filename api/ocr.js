// api/ocr.js
// 董事長聯絡事項查詢系統 — 名片／手寫筆記 OCR 辨識代理
// 前端把拍到的照片(base64)傳來，這裡呼叫 DeepInfra 的視覺模型辨識文字，
// 整理成跟 interview_records 資料庫欄位一致的 JSON 回傳給前端，
// 前端只會把結果「帶入手動新增表單」讓使用者確認/修改，這支API本身不會寫入資料庫。
// AI_BASE_URL 沿用跟 ask.js 一樣的 DeepInfra 端點與同一組 DEEPINFRA_API_KEY_INTERVIEWS，
// 辨識模型用可抽換的 AI_MODEL_OCR，未來要換供應商/模型只需在 Vercel 環境變數覆蓋。

const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.deepinfra.com/v1/openai/chat/completions';
const AI_MODEL_OCR = process.env.AI_MODEL_OCR || 'Qwen/Qwen2.5-VL-32B-Instruct';
const AI_API_KEY = process.env.DEEPINFRA_API_KEY_INTERVIEWS;

// ---- AI用量統計：推播設定（跟 ask.js 用同一張中央統計表，用model欄位區分是問答還是辨識）----
const SYSTEM_NAME = 'interview';
const API_KEY_NAME = 'DEEPINFRA_API_KEY_INTERVIEWS';
const STATS_PUSH_URL = process.env.STATS_PUSH_URL || 'https://bvuygyajzupeqpqfwmgi.supabase.co/functions/v1/stats-ai-usage-push';
const STATS_PUSH_SECRET = process.env.STATS_PUSH_SECRET;
const STATS_PUSH_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ2dXlneWFqenVwZXFwcWZ3bWdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNjA5MjQsImV4cCI6MjA5NzczNjkyNH0.zvP-JWgHRWiCKZbqSSU6-uGgx3WHwG0nFxfG8xDhEH8';

async function pushUsageStats({ promptTokens, completionTokens, askerEmail }) {
  if (!STATS_PUSH_SECRET) return; // 尚未設定推播密鑰時直接跳過，不報錯
  try {
    await fetch(STATS_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${STATS_PUSH_ANON_KEY}`, 'x-push-secret': STATS_PUSH_SECRET },
      body: JSON.stringify({
        system_name: SYSTEM_NAME,
        api_key_name: API_KEY_NAME,
        ai_provider: 'deepinfra',
        ai_model: AI_MODEL_OCR,
        asker_email: askerEmail || null,
        prompt_tokens: promptTokens || 0,
        completion_tokens: completionTokens || 0,
        total_tokens: (promptTokens || 0) + (completionTokens || 0),
        cache_hit: false
      })
    });
  } catch (e) {
    console.error('推播AI用量統計失敗（不影響本次辨識結果）:', e);
  }
}

const SYSTEM_PROMPT = '你是專業的名片與手寫筆記辨識助理。使用者會傳一張照片，內容可能是名片，也可能是手寫的會談筆記，文字可能是繁體中文、簡體中文或英文。'
  + '請仔細判讀圖片中的文字，並把結果整理成以下欄位，只能回傳一個JSON物件本身，不要有任何其他文字、不要用markdown的```包住、不要加任何說明：\n'
  + '{"record_date":"","company":"","person":"","content":"","companion":"","note":""}\n'
  + '欄位規則：\n'
  + '- record_date：只有當圖片上「明確手寫或印刷出一組實際日期數字」時才填，例如「2024/5/10」「113年5月10日」「5/10」這種有寫出年月日數字的情況。\n'
  + '  如果圖片上是「Date:」「日期：」這種欄位標籤但後面是空白、沒有實際寫日期，一律留空字串，絕對不可以自己編造或推測一個日期去填。\n'
  + '  如果是民國年(例如113年、115年)，要換算成西元年(民國年+1911)再轉成YYYY-MM-DD格式。\n'
  + '  絕對不要把文件裡其他不相關的數字(例如截止期限、編號、金額、電話)誤認成日期。\n'
  + '  名片通常不會有日期，看不到日期就留空字串。\n'
  + '- company：公司/單位名稱。\n'
  + '- person：這張名片的主要人員姓名；如果是手寫筆記，填看得出來的主要對象姓名。\n'
  + '- content：這個欄位是給「這次聯絡實際談了什麼事」用的。如果是名片，這裡固定留空字串，不要把職稱/電話/地址等名片資訊放進來；如果是手寫筆記，這裡填筆記內容的重點敘述。\n'
  + '- companion：如果看得出是陪同其他人一起(例如筆記中提到還有誰在場)，填陪同人員姓名；名片通常沒有這個資訊，看不出來就留空字串。\n'
  + '- note：如果是名片，把職稱、電話、email、地址、公司其他資訊等名片上的內容，全部整理放在這裡，每一項用換行分隔；如果是手寫筆記，這裡放看得出來、但前面欄位放不下的補充資訊。沒有就留空字串。\n'
  + '看不清楚、模糊、或無法判斷的欄位，一律留空字串，絕對不要瞎猜或編造內容，尤其是日期欄位，寧可留空也不要猜。';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { image, mime_type, asker_email } = req.body || {};

  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: '缺少 image' });
    return;
  }

  if (!AI_API_KEY) {
    res.status(500).json({ error: '伺服器未設定 DEEPINFRA_API_KEY_INTERVIEWS' });
    return;
  }

  // 前端傳的 image 通常已經是完整的 data:image/xxx;base64,.... 格式(FileReader.readAsDataURL的結果)
  // 這裡多做一層防呆：萬一前端只傳了純base64字串，就用mime_type自己組成data URL
  const dataUrl = image.startsWith('data:') ? image : `data:${mime_type || 'image/jpeg'};base64,${image}`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: '請辨識這張圖片，回傳指定格式的JSON，不要有其他文字。' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ];

  try {
    const aiRes = await fetch(AI_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL_OCR,
        messages,
        temperature: 0.1
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('OCR AI 服務錯誤:', aiRes.status, errText);
      res.status(502).json({ error: 'AI 辨識服務呼叫失敗' });
      return;
    }

    const data = await aiRes.json();
    let raw = (data?.choices?.[0]?.message?.content || '').trim();
    // 防呆：萬一模型還是回了markdown code fence包住的json，先把它剝掉再解析
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    let fields;
    try {
      fields = JSON.parse(raw);
    } catch (e) {
      console.error('OCR結果不是合法JSON:', raw);
      res.status(502).json({ error: 'AI辨識結果格式異常，請重新拍照或直接手動輸入' });
      return;
    }

    const usage = data?.usage || {};
    await pushUsageStats({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      askerEmail: asker_email
    });

    res.status(200).json({
      record_date: fields.record_date || '',
      company: fields.company || '',
      person: fields.person || '',
      content: fields.content || '',
      companion: fields.companion || '',
      note: fields.note || ''
    });
  } catch (err) {
    console.error('OCR辨識發生例外:', err);
    res.status(500).json({ error: 'AI辨識服務發生錯誤' });
  }
}
