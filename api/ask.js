// api/ask.js
// 董事長聯絡事項查詢系統 — 伺服器端代理
// 接收前端已用關鍵字模糊搜尋出來的訪談紀錄(records)與使用者問題(question)，
// 呼叫 Groq API 產生摘要回答。
// GROQ_API_KEY 只存在於伺服器環境變數，不會傳到前端。

const SYSTEM_PROMPT = '你是董事長的訪談紀錄查詢助理。根據提供的訪談紀錄，用繁體中文回答使用者的問題。'
  + '回答時請整理出：這個人總共見過幾次、每次的日期、地點/場合、談話重點。'
  + '如果有多筆紀錄，請按日期排序後條列說明，不要遺漏任何一筆。'
  + '如果提供的紀錄中找不到與問題相關的人或內容，請直接說明「查無相關紀錄」，不要編造內容。'
  + '回答要簡潔，用條列式呈現，方便在手機上快速閱讀。';

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

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    res.status(500).json({ error: '伺服器未設定 GROQ_API_KEY' });
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
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.3
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq API 錯誤:', groqRes.status, errText);
      res.status(502).json({ error: 'AI 服務呼叫失敗' });
      return;
    }

    const data = await groqRes.json();
    const answer = data?.choices?.[0]?.message?.content || '抱歉，無法產生回答。';
    res.status(200).json({ answer });
  } catch (err) {
    console.error('呼叫 Groq API 發生例外:', err);
    res.status(500).json({ error: 'AI 服務發生錯誤' });
  }
}
