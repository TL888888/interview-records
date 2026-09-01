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

const SYSTEM_PROMPT = '你是董事長的聯絡事項查詢助理。根據提供的訪談/聯絡紀錄，用繁體中文回答使用者的問題。'
  + '請用自然的口語幫忙整理重點，不要逐項照抄「日期：xx／公司：xx／人員：xx」這種資料庫欄位格式，改成像跟人說話一樣的敘述句。'
  + '例如可以寫成：「王小明總共出現3次，最近一次是2024-05-10在ABC公司談XX事宜，另外2023年也曾在...」這樣的寫法。'
  + '紀錄裡如果某個欄位是空的或沒有資料，就直接略過、不要提到它，不要為了格式完整而寫「無」。'
  + '如果有多筆紀錄，先說總共出現幾次，再依日期新到舊，簡短敘述每次的重點，不要遺漏任何一筆。'
  + '如果提供的紀錄中找不到與問題相關的人或內容，請直接說明「查無相關紀錄」，不要編造內容。'
  + '回答要簡潔，方便在手機上快速閱讀。'
  + '絕對不要使用任何markdown語法，包括表格（|和---組成的表格）、星號粗體（**文字**）、井字號標題（#）、項目符號(-或*開頭)，全部都只能用純文字與正常標點，需要分項時用「一、二、三」或換行加編號的方式呈現。'
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

  // records 是前端從 Supabase 模糊搜尋出來的 interview_records 紀錄陣列
  // 實際欄位：record_date、company、person、content、companion、note
  // 這裡先把空欄位濾掉，只把有內容的資訊交給AI，減少AI逐欄位照抄「無」的機會
  const recordsText = Array.isArray(records) && records.length > 0
    ? records
        .map((r, i) => {
          const parts = [];
          if (r.record_date) parts.push(`日期：${r.record_date}`);
          if (r.company) parts.push(`公司/單位：${r.company}`);
          if (r.person) parts.push(`人員：${r.person}`);
          if (r.content) parts.push(`內容：${r.content}`);
          if (r.companion) parts.push(`陪同人員：${r.companion}`);
          if (r.note) parts.push(`備註：${r.note}`);
          return `【紀錄 ${i + 1}】\n` + parts.join('\n');
        })
        .join('\n\n')
    : '(查無符合的紀錄)';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `以下是搜尋到的聯絡紀錄：\n\n${recordsText}\n\n使用者問題：\n${question}`
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
