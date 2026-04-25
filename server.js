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

// Basit ürün havuzu
const PRODUCTS = [
  {
    name: "La Roche-Posay Effaclar Temizleme Jeli",
    url: "https://www.expo-pharma.com/products/la-roche-posay-effaclar-temizleme-jeli"
  },
  {
    name: "Bioderma Pigmentbio Serum",
    url: "https://www.expo-pharma.com/products/bioderma-pigmentbio-serum"
  },
  {
    name: "Vichy SPF 50 Güneş Koruyucu",
    url: "https://www.expo-pharma.com/products/vichy-spf50"
  },
  {
    name: "CeraVe Nemlendirici Losyon",
    url: "https://www.expo-pharma.com/products/cerave-nemlendirici-losyon"
  }
];

app.post("/api/clavis-analyze", async (req, res) => {
  try {
    const userInput =
      req.body?.input ||
      req.body?.message ||
      req.body?.prompt ||
      "";

    if (!userInput) {
      return res.status(400).json({ error: "Kullanıcı girdisi yok." });
    }

    const productList = PRODUCTS.map(
      (p) => `- ${p.name}: ${p.url}`
    ).join("\n");

    const prompt = `
Türkçe yaz.
Tıbbi teşhis koyma.
Nazik ve güvenli öneriler ver.
"yardımcı olabilir", "destekleyebilir" gibi ifadeler kullan.

Kullanıcı şunu yazdı:
"${userInput}"

Şu başlıklarda cevap ver:
1. Kısa değerlendirme
2. Sabah rutini
3. Akşam rutini
4. Önerilebilecek ürünler

Ürün listesi:
${productList}
`;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt
    });

    const text =
      response.output_text ||
      "Şu anda cevap oluşturulamadı.";

    return res.json({
      result: text
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "CLAVIS AI şu anda yanıt veremiyor."
    });
  }
});

// Test endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log("Server çalışıyor:", port);
});
