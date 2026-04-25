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

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN,
  methods: ["POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "10mb" }));

// ÜRÜN HAVUZU
const PRODUCTS = [
  {
    name: "La Roche-Posay Effaclar Temizleme Jeli",
    tags: ["akne", "yağlı"],
    url: "https://www.expo-pharma.com/products/la-roche-posay-effaclar-temizleme-jeli"
  },
  {
    name: "Bioderma Pigmentbio Serum",
    tags: ["leke"],
    url: "https://www.expo-pharma.com/products/bioderma-pigmentbio-serum"
  },
  {
    name: "Vichy SPF 50",
    tags: ["spf"],
    url: "https://www.expo-pharma.com/products/vichy-spf50"
  }
];

// TRIAGE + ANALİZ
app.post("/api/clavis-analyze", async (req, res) => {
  try {
    const { message, answers, stage } = req.body;

    // 1️⃣ SORU SORMA
    if (stage === "triage") {
      const prompt = `
Sen bir eczacısın.

Kullanıcıdan doğru ürünü önermek için maksimum 4 kısa soru sor.

JSON dön:
{
 "questions": ["soru1", "soru2"],
 "needImage": true
}

Kullanıcı:
${message}
`;

      const r = await client.responses.create({
        model: "gpt-5.4",
        input: prompt
      });

      return res.json(JSON.parse(r.output_text));
    }

    // 2️⃣ ANALİZ + ÜRÜN
    if (stage === "analysis") {

      const text = JSON.stringify(answers).toLowerCase();

      const matched = PRODUCTS.filter(p =>
        p.tags.some(tag => text.includes(tag))
      );

      const prompt = `
Sen eczacısın.

KISA analiz yap ve ürün öner.

Kullanıcı:
${JSON.stringify(answers)}
`;

      const r = await client.responses.create({
        model: "gpt-5.4",
        input: prompt
      });

      return res.json({
        analysis: r.output_text,
        products: matched
      });
    }

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "CLAVIS AI hata verdi" });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log("Server çalışıyor:", port);
});
