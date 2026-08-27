// api/ask.js
// 董事長聯絡事項查詢系統 — 伺服器端代理
// 接收前端已用關鍵字模糊搜尋出來的訪談紀錄(records)與使用者問題(question)，
// 呼叫 AI 服務產生摘要回答。
// 供應商可抽換式設計：AI_BASE_URL / AI_MODEL 可用環境變數覆蓋，換供應商不用改程式碼。
// DEEPINFRA_API_KEY_INTERVIEWS 只存在於伺服器環境變數，不會傳到前端。

// ---- AI 供應商設定（可抽換）：預設 DeepInfra，未來要換供應商只需在 Vercel 環境變數覆蓋這兩個值 ----
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.deepinfra.com/v1/openai/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-oss-120b';
const AI_API_KEY = process.env.DEEPINFRA_API_KEY_INTERVIEWS;

const SYSTEM_PROMPT = '你是董事長的訪談紀錄查詢助理。根據提供的訪談紀錄，用繁體中文回答使用者的問題。'
  + '回答時請整理出：這個人總共見過幾次、每次的日期、地點/場合、談話重點。'
  + '如果有多筆紀錄，請按日期排序後條列說明，不要遺漏任何一筆。'
  + '如果提供的紀錄中找不到與問題相關的人或內容，請直接說明「查無相關紀錄」，不要編造內容。'
  + '回答要簡潔，用條列式呈現，方便在手機上快速閱讀。'
  + '絕對不要輸出markdown表格語法（不要用|和---組成的表格），一律用條列文字說明。'
  + '稱呼使用者一律用「您」，整段回答從頭到尾保持一致。';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { question, records } = req.body || {};

  if (!question || typeof question !== 'string') {
    res.status(400).json({ error: '缺少 question' });
    return;
  }

  if (!AI_API_KEY) {
    res.status(500).json({ error: '伺服器未設定 DEEPINFRA_API_KEY_INTERVIEWS' });
    return;
  }

  // records 是前端從 Supabase 模糊搜尋出來的訪談紀錄陣列
  // 每筆預期欄位：姓名、公司名稱、職稱、場合類型、地點、日期、談話重點
  const recordsText = Array.isArray(records) && records.length > 0
    ? records
        .map((r, i) => {
          return `【紀錄 ${i + 1}】\n`
            + `姓名：${r.name || ''}\n`
            + `公司：${r.company || ''}\n`
            + `職稱：${r.title || ''}\n`
            + `場合：${r.occasion_type || ''}\n`
            + `地點：${r.location || ''}\n`
            + `日期：${r.date || ''}\n`
            + `談話重點：${r.summary || ''}`;
        })
        .join('\n\n')
    : '(查無符合的紀錄)';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `以下是搜尋到的訪談紀錄：\n\n${recordsText}\n\n使用者問題：\n${question}`
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
        model: AI_MODEL,
        messages,
        temperature: 0.3
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('AI 服務錯誤:', aiRes.status, errText);
      res.status(502).json({ error: 'AI 服務呼叫失敗' });
      return;
    }

    const data = await aiRes.json();
    const answer = data?.choices?.[0]?.message?.content || '抱歉，無法產生回答。';
    res.status(200).json({ answer });
  } catch (err) {
    console.error('呼叫 AI 服務發生例外:', err);
    res.status(500).json({ error: 'AI 服務發生錯誤' });
  }
}
