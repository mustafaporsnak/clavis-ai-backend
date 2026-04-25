import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({ status: "CLAVIS AI backend aktif" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/clavis-analyze", async (req, res) => {
  try {
    console.log("BODY:", req.body);

    const userInput =
      req.body?.input ||
      req.body?.message ||
      req.body?.prompt ||
      req.body?.userNote ||
      "";

    if (!userInput || !userInput.trim()) {
      return res.status(400).json({
        error: "Kullanıcı girdisi yok."
      });
    }

    const prompt = `
Sen Expo Pharma'nın CLAVIS AI ürün danışmanısın.

Türkçe cevap ver.
Tıbbi teşhis koyma.
Reçete, ilaç tedavisi veya kesin tedavi önerme.
Kozmetik, dermokozmetik, vitamin ve genel ürün danışmanlığı dilinde konuş.
"yardımcı olabilir", "destekleyebilir", "uygun olabilir" gibi güvenli ifadeler kullan.

Kullanıcının sorusu:
${userInput}

Cevabı şu formatta ver:

1. Kısa Değerlendirme
2. Sabah Rutini
3. Akşam Rutini
4. Dikkat Edilmesi Gerekenler
5. Eczacıya Danış Notu

Cevap sade, anlaşılır ve satış sitesine uygun olsun.
`;

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: prompt
    });

    const result =
      response.output_text ||
      "Şu anda sonuç oluşturulamadı. Lütfen tekrar deneyin.";

    return res.json({
      result: result,
      disclaimer:
        "Bu öneri genel ürün danışmanlığıdır. Tanı ve tedavi yerine geçmez."
    });
  } catch (error) {
    console.error("CLAVIS ERROR:", error);

    return res.status(500).json({
      error: "CLAVIS AI şu anda yanıt veremiyor."
    });
  }
});

app.listen(port, () => {
  console.log(`CLAVIS AI backend running on port ${port}`);
});
