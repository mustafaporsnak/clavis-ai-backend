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
app.use(express.json({ limit: "15mb" }));

/*
  ÜRÜN HAVUZU
  Buradaki ürünler örnektir. Sonra gerçek Shopify ürün linklerinle genişleteceğiz.
  CLAVIS sadece bu listedeki ürünleri önermeye çalışacak.
*/
const PRODUCTS = [
  {
    id: "cilt-yagli-akne-temizleyici",
    name: "Yağlı ve akneye eğilimli ciltler için nazik temizleyici",
    category: "Cilt Bakımı",
    tags: ["sivilce", "akne", "yağlı", "karma", "gözenek", "temizleyici"],
    url: "https://www.expo-pharma.com/collections/cilt-bakimi",
    reason: "Yağlı ve akneye eğilimli ciltlerde günlük temizleme adımı için değerlendirilebilir."
  },
  {
    id: "cilt-nem-bariyer",
    name: "Hassas cilt bariyerini destekleyen nemlendirici",
    category: "Cilt Bakımı",
    tags: ["kuruluk", "hassas", "bariyer", "kızarıklık", "nem", "nemlendirici"],
    url: "https://www.expo-pharma.com/collections/cilt-bakimi",
    reason: "Cilt bariyerini desteklemeye yardımcı nemlendirme adımı için değerlendirilebilir."
  },
  {
    id: "cilt-leke-spf",
    name: "Leke görünümü ve güneş koruması için SPF ürünü",
    category: "Cilt Bakımı",
    tags: ["leke", "güneş", "spf", "iz", "ton", "pigment"],
    url: "https://www.expo-pharma.com/collections/cilt-bakimi",
    reason: "Leke görünümü ve güneş hassasiyetinde gündüz koruma adımı için değerlendirilebilir."
  },
  {
    id: "anne-bebek-bakim",
    name: "Anne ve bebek bakım ürünleri",
    category: "Anne & Bebek",
    tags: ["bebek", "pişik", "anne", "çocuk", "hassas bebek"],
    url: "https://www.expo-pharma.com/collections/anne-bebek",
    reason: "Anne ve bebek bakım ihtiyaçlarında ilgili ürün grubuna yönlendirme yapılabilir."
  },
  {
    id: "vitamin-destek",
    name: "Günlük vitamin ve takviye ürünleri",
    category: "Vitamin & Takviyeler",
    tags: ["vitamin", "takviye", "enerji", "bağışıklık", "yorgunluk"],
    url: "https://www.expo-pharma.com/collections/vitamin-takviyeler",
    reason: "Genel destek ihtiyacında vitamin ve takviye kategorisi değerlendirilebilir."
  },
  {
    id: "medikal-urunler",
    name: "Medikal ürünler",
    category: "Medikal Ürünler",
    tags: ["medikal", "ölçüm", "cihaz", "tansiyon", "şeker", "ateş"],
    url: "https://www.expo-pharma.com/collections/medikal-urunler",
    reason: "Medikal cihaz ve yardımcı ürün ihtiyaçlarında ilgili kategoriye yönlendirme yapılabilir."
  }
];

function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replaceAll("ı", "i")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ş", "s")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c");
}

function matchProducts(text) {
  const normalized = normalizeText(text);

  const scored = PRODUCTS.map((product) => {
    let score = 0;

    product.tags.forEach((tag) => {
      const normalizedTag = normalizeText(tag);
      if (normalized.includes(normalizedTag)) score += 3;
    });

    return { ...product, score };
  })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length > 0) return scored;

  return [
    {
      ...PRODUCTS[0],
      score: 1
    },
    {
      ...PRODUCTS[1],
      score: 1
    }
  ];
}

function safeJsonParse(text) {
  try {
    const cleaned = String(text || "")
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }

    return null;
  } catch {
    return null;
  }
}

app.get("/", (req, res) => {
  res.json({ status: "CLAVIS AI backend aktif" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/clavis-analyze", async (req, res) => {
  try {
    const { stage, message, answers, imageBase64 } = req.body || {};

    if (stage === "triage") {
      if (!message || !String(message).trim()) {
        return res.status(400).json({ error: "Kullanıcı mesajı boş." });
      }

      const triagePrompt = `
Sen Expo Pharma'nın CLAVIS AI eczacı destek asistanısın.

Görevin:
Kullanıcının ihtiyacını anlamak için kısa ve hedefli sorular sormak.

Kurallar:
- Tanı koyma.
- Tedavi iddiası yazma.
- Ürün satmaya acele etme.
- Kullanıcıya eczacı ilgisi hissettir.
- Maksimum 4 soru sor.
- Sorular kısa, anlaşılır ve cevaplanabilir olsun.
- Cilt sorunu varsa: bölge, süre, görünüm, hassasiyet/ürün kullanımı gibi konuları sor.
- Akne/sivilce gibi cilt sorunlarında görsel faydalı olabilir; needImage true dönebilirsin.
- Sadece JSON döndür.

Kullanıcı mesajı:
${message}

JSON formatı:
{
  "intro": "Kısa güven veren bir cümle",
  "questions": [
    "1. soru",
    "2. soru",
    "3. soru",
    "4. soru"
  ],
  "needImage": true
}
`;

      const response = await client.responses.create({
        model: "gpt-4o-mini",
        input: triagePrompt
      });

      const parsed = safeJsonParse(response.output_text);

      if (!parsed || !Array.isArray(parsed.questions)) {
        return res.json({
          intro: "Doğru yönlendirme yapabilmem için birkaç kısa bilgiye ihtiyacım var.",
          questions: [
            "Şikâyetiniz ne kadar süredir var?",
            "Hangi bölgede daha yoğun?",
            "Kızarık, iltihaplı veya ağrılı mı?",
            "Cildiniz yağlı, kuru, karma veya hassas mı?"
          ],
          needImage: true
        });
      }

      return res.json(parsed);
    }

    if (stage === "analysis") {
      if (!answers) {
        return res.status(400).json({ error: "Cevaplar eksik." });
      }

      const answerText = JSON.stringify(answers);
      const matchedProducts = matchProducts(answerText);

      const productText = matchedProducts
        .map((p) => `- ${p.name} | Kategori: ${p.category} | Link: ${p.url} | Not: ${p.reason}`)
        .join("\n");

      const content = [
        {
          type: "input_text",
          text: `
Sen Expo Pharma'nın CLAVIS AI eczacı destek asistanısın.

Görevin:
Kullanıcının verdiği cevaplara göre genel ürün danışmanlığı yapmak.

Çok önemli kurallar:
- Tanı koyma.
- "Akne hastalığı", "enfeksiyon", "tedavi eder", "kesin geçirir" gibi kesin ifadeler kullanma.
- "Şu görünüme eğilim olabilir", "uygun olabilir", "destekleyebilir", "değerlendirilebilir" gibi güvenli dil kullan.
- Direkt ürün satmaya çalışma; önce kısa değerlendirme yap.
- Uygun değilse ürün önermemeyi bil.
- Kırmızı bayrak varsa doktora/dermatoloğa yönlendir: yaygın iltihap, şiddetli ağrı, ani kötüleşme, yara, kanama, göz çevresi, hamilelik, bebek/çocuk, yoğun alerji şüphesi.
- Ürün önerirken sadece aşağıdaki ürün havuzundan öner.
- En fazla 3 ürün/kategori öner.
- Cevap Türkçe olsun.
- Kısa ama güven veren profesyonel tonda yaz.

Kullanıcı cevapları:
${answerText}

Kullanılabilir ürün/kategori havuzu:
${productText}

Cevabı şu başlıklarla yaz:

1. Kısa Değerlendirme
2. Sizin İçin Netleştirdiğim Noktalar
3. Genel Bakım Yaklaşımı
4. Expo Pharma Ürün/Kategori Önerisi
5. Ne Zaman Uzman Görüşü Alınmalı
6. Eczacı Notu
`
        }
      ];

      if (imageBase64 && String(imageBase64).startsWith("data:image")) {
        content.push({
          type: "input_image",
          image_url: imageBase64
        });
      }

      const response = await client.responses.create({
        model: "gpt-4o-mini",
        input: [
          {
            role: "user",
            content
          }
        ]
      });

      return res.json({
        analysis: response.output_text || "Analiz oluşturulamadı.",
        products: matchedProducts,
        disclaimer:
          "Bu hizmet genel ürün danışmanlığı sağlar. Tanı ve tedavi yerine geçmez."
      });
    }

    return res.status(400).json({ error: "Geçersiz stage." });
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
