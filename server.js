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
app.use(express.json({ limit: "20mb" }));

const SHOP_DOMAIN = "https://www.expo-pharma.com";

/* -------------------------------
   Yardımcı fonksiyonlar
-------------------------------- */

function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replaceAll("ı", "i")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ş", "s")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c")
    .trim();
}

function toNumber(value) {
  const n = Number(String(value || "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
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

/* -------------------------------
   Shopify ürünlerini oku
-------------------------------- */

async function fetchShopifyProducts() {
  const url = `${SHOP_DOMAIN}/products.json?limit=250`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Shopify ürünleri okunamadı.");
  }

  const data = await response.json();
  const products = Array.isArray(data.products) ? data.products : [];

  return products.map((p) => {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const firstVariant = variants[0] || {};
    const price = toNumber(firstVariant.price);
    const compareAtPrice = toNumber(firstVariant.compare_at_price);

    return {
      id: p.id,
      title: p.title || "",
      handle: p.handle || "",
      vendor: p.vendor || "",
      product_type: p.product_type || "",
      tags: Array.isArray(p.tags) ? p.tags : [],
      body_html: p.body_html || "",
      url: `${SHOP_DOMAIN}/products/${p.handle}`,
      image:
        p.featured_image ||
        (Array.isArray(p.images) && p.images[0] ? p.images[0].src : ""),
      available: Boolean(firstVariant.available),
      price,
      compareAtPrice,
      variants: variants.map((v) => ({
        id: v.id,
        title: v.title || "",
        sku: v.sku || "",
        price: toNumber(v.price),
        compareAtPrice: toNumber(v.compare_at_price),
        available: Boolean(v.available)
      }))
    };
  });
}

/* -------------------------------
   Ürün eşleştirme
-------------------------------- */

async function matchProductsFromShopify(answerText) {
  const products = await fetchShopifyProducts();
  const normalizedAnswer = normalizeText(answerText);

  const scored = products.map((product) => {
    const searchText = normalizeText(`
      ${product.title}
      ${product.vendor}
      ${product.product_type}
      ${product.tags.join(" ")}
      ${product.body_html}
    `);

    let score = 0;

    const keywords = [
      "sivilce",
      "akne",
      "yağlı",
      "yagli",
      "leke",
      "güneş",
      "gunes",
      "spf",
      "hassas",
      "kuruluk",
      "nem",
      "bariyer",
      "vitamin",
      "takviye",
      "bebek",
      "pişik",
      "pisik",
      "medikal",
      "tansiyon",
      "şeker",
      "seker"
    ];

    keywords.forEach((keyword) => {
      const k = normalizeText(keyword);
      if (normalizedAnswer.includes(k) && searchText.includes(k)) {
        score += 3;
      }
    });

    if (product.available) score += 1;
    if (product.price > 0) score += 1;

    return {
      ...product,
      score
    };
  });

  return scored
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

/* -------------------------------
   Fiyat / ürün denetimi
-------------------------------- */

function auditProducts(products, options = {}) {
  const minSuspiciousPrice = Number(options.minSuspiciousPrice || 10);

  const zeroPrice = [];
  const missingImage = [];
  const missingHandle = [];
  const suspiciousLowPrice = [];
  const compareAtProblem = [];
  const variantPriceMismatch = [];

  products.forEach((product) => {
    if (!product.handle) {
      missingHandle.push(product);
    }

    if (!product.image) {
      missingImage.push(product);
    }

    if (!product.price || product.price <= 0) {
      zeroPrice.push(product);
    }

    if (product.price > 0 && product.price < minSuspiciousPrice) {
      suspiciousLowPrice.push(product);
    }

    if (
      product.compareAtPrice > 0 &&
      product.price > 0 &&
      product.compareAtPrice < product.price
    ) {
      compareAtProblem.push(product);
    }

    const validVariantPrices = product.variants
      .map((v) => v.price)
      .filter((p) => p > 0);

    if (validVariantPrices.length >= 2) {
      const min = Math.min(...validVariantPrices);
      const max = Math.max(...validVariantPrices);

      if (min > 0 && max / min >= 3) {
        variantPriceMismatch.push({
          ...product,
          minVariantPrice: min,
          maxVariantPrice: max
        });
      }
    }
  });

  return {
    summary: {
      totalProducts: products.length,
      zeroPriceCount: zeroPrice.length,
      missingImageCount: missingImage.length,
      missingHandleCount: missingHandle.length,
      suspiciousLowPriceCount: suspiciousLowPrice.length,
      compareAtProblemCount: compareAtProblem.length,
      variantPriceMismatchCount: variantPriceMismatch.length
    },
    zeroPrice,
    missingImage,
    missingHandle,
    suspiciousLowPrice,
    compareAtProblem,
    variantPriceMismatch
  };
}

/* -------------------------------
   Temel endpointler
-------------------------------- */

app.get("/", (req, res) => {
  res.json({
    status: "CLAVIS AI backend aktif",
    health: "/health",
    products: "/api/shopify-products",
    priceAudit: "/api/price-audit"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* -------------------------------
   Shopify ürün listeleme endpointi
-------------------------------- */

app.get("/api/shopify-products", async (req, res) => {
  try {
    const products = await fetchShopifyProducts();

    return res.json({
      count: products.length,
      products
    });
  } catch (error) {
    console.error("SHOPIFY PRODUCTS ERROR:", error);
    return res.status(500).json({
      error: "Shopify ürünleri okunamadı."
    });
  }
});

/* -------------------------------
   Fiyat denetimi endpointi
-------------------------------- */

app.get("/api/price-audit", async (req, res) => {
  try {
    const minSuspiciousPrice = req.query.minPrice || 10;
    const products = await fetchShopifyProducts();
    const report = auditProducts(products, { minSuspiciousPrice });

    return res.json(report);
  } catch (error) {
    console.error("PRICE AUDIT ERROR:", error);
    return res.status(500).json({
      error: "Fiyat denetimi yapılamadı."
    });
  }
});

/* -------------------------------
   CLAVIS AI danışmanlık endpointi
-------------------------------- */

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
          intro:
            "Doğru yönlendirme yapabilmem için birkaç kısa bilgiye ihtiyacım var.",
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
      const matchedProducts = await matchProductsFromShopify(answerText);

      const productText =
        matchedProducts.length > 0
          ? matchedProducts
              .map(
                (p) =>
                  `- ${p.title} | Fiyat: ${p.price} TL | Link: ${p.url} | Kategori: ${p.product_type || "Belirtilmemiş"}`
              )
              .join("\n")
          : "Uygun ürün eşleşmesi bulunamadı.";

      const content = [
        {
          type: "input_text",
          text: `
Sen Expo Pharma'nın CLAVIS AI eczacı destek asistanısın.

Görevin:
Kullanıcının verdiği cevaplara göre genel ürün danışmanlığı yapmak.

Çok önemli kurallar:
- Tanı koyma.
- "Tedavi eder", "kesin geçirir", "hastalığı iyileştirir" gibi kesin ifadeler kullanma.
- "Uygun olabilir", "destekleyebilir", "değerlendirilebilir" gibi güvenli dil kullan.
- Direkt ürün satmaya çalışma; önce kısa değerlendirme yap.
- Uygun değilse ürün önermemeyi bil.
- Kırmızı bayrak varsa doktora/dermatoloğa yönlendir.
- Ürün önerirken sadece aşağıdaki ürün havuzundan öner.
- En fazla 4 ürün öner.
- Cevap Türkçe olsun.
- Kısa ama güven veren profesyonel tonda yaz.

Kullanıcı cevapları:
${answerText}

Siteden eşleşen ürünler:
${productText}

Cevabı şu başlıklarla yaz:

1. Kısa Değerlendirme
2. Sizin İçin Netleştirdiğim Noktalar
3. Genel Bakım Yaklaşımı
4. Expo Pharma Ürün Önerisi
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
        products: matchedProducts.map((p) => ({
          id: p.id,
          name: p.title,
          title: p.title,
          url: p.url,
          image: p.image,
          price: p.price,
          compareAtPrice: p.compareAtPrice,
          available: p.available,
          reason: "Verdiğiniz bilgilere göre bu ürün/kategori değerlendirilebilir."
        })),
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
