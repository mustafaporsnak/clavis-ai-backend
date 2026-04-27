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
const CLAVIS_ADMIN_PASSWORD = process.env.CLAVIS_ADMIN_PASSWORD;
const CLAVIS_SHEET_URL = process.env.CLAVIS_SHEET_URL;

/* -------------------------------
   ADMIN ŞİFRE KONTROLÜ
-------------------------------- */

function checkAdminPassword(req, res, next) {
  const password = String(req.headers["x-clavis-admin-password"] || "").trim();
  const realPassword = String(CLAVIS_ADMIN_PASSWORD || "").trim();

  if (!realPassword) {
    return res.status(500).json({
      error: "Admin şifresi Render Environment içinde tanımlı değil."
    });
  }

  if (!password || password !== realPassword) {
    return res.status(401).json({
      error: "Yetkisiz erişim. Şifre hatalı veya eksik."
    });
  }

  next();
}

  next();
}

/* -------------------------------
   YARDIMCI FONKSİYONLAR
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
  if (typeof value === "number") return value;

  const cleaned = String(value || "")
    .replace("TL", "")
    .replace("₺", "")
    .replaceAll(".", "")
    .replace(",", ".")
    .trim();

  const n = Number(cleaned);
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

function getField(item, possibleNames) {
  for (const name of possibleNames) {
    if (item[name] !== undefined && item[name] !== null && item[name] !== "") {
      return item[name];
    }
  }
  return "";
}

/* -------------------------------
   GOOGLE SHEET MALİYET TABLOSU
-------------------------------- */

async function fetchCostSheet() {
  if (!CLAVIS_SHEET_URL) {
    return [];
  }

  const response = await fetch(CLAVIS_SHEET_URL);

  if (!response.ok) {
    throw new Error("Google Sheet maliyet tablosu okunamadı.");
  }

  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items : [];

  return items.map((item) => {
    return {
      handle: String(getField(item, ["handle", "Handle"]) || "").trim(),
      sku: String(getField(item, ["sku", "SKU"]) || "").trim(),
      barcode: String(getField(item, ["barkod", "barcode", "Barkod"]) || "").trim(),
      productName: String(getField(item, ["ürün adı", "urun adı", "ürün adi", "product name"]) || "").trim(),
      supplyType: String(getField(item, ["tedarik tipi", "supply type"]) || "").trim(),
      costPrice: toNumber(getField(item, ["geliş fiyatı", "gelis fiyati", "geliş fiyat", "maliyet"])),
      psf: toNumber(getField(item, ["PSF", "psf"])),
      minimumSalePrice: toNumber(getField(item, ["minimum satış fiyatı", "minimum satis fiyati"])),
      shippingCost: toNumber(getField(item, ["kargo maliyeti", "kargo"])),
      paymentCommissionRate: toNumber(getField(item, ["ödeme komisyonu %", "odeme komisyonu %", "komisyon %"])),
      pharmacistCommission: toNumber(getField(item, ["eczacı komisyonu", "eczaci komisyonu"])),
      pharmacistCommissionType: String(getField(item, ["eczacı komisyon tipi", "eczaci komisyon tipi"]) || "TL").trim(),
      targetProfitRate: toNumber(getField(item, ["hedef kâr %", "hedef kar %"])),
      note: String(getField(item, ["not", "Not"]) || "").trim()
    };
  });
}

function matchCostData(product, costItems) {
  const productHandle = normalizeText(product.handle);
  const productSkuList = product.variants.map((v) => normalizeText(v.sku)).filter(Boolean);

  return costItems.find((item) => {
    const itemHandle = normalizeText(item.handle);
    const itemSku = normalizeText(item.sku);

    if (itemHandle && itemHandle === productHandle) return true;
    if (itemSku && productSkuList.includes(itemSku)) return true;

    return false;
  });
}

function calculateProfit(product, cost) {
  const salePrice = Number(product.price || 0);
  const costPrice = Number(cost?.costPrice || 0);
  const shippingCost = Number(cost?.shippingCost || 0);
  const paymentRate = Number(cost?.paymentCommissionRate || 0);

  let pharmacistCommission = Number(cost?.pharmacistCommission || 0);

  if (String(cost?.pharmacistCommissionType || "").includes("%")) {
    pharmacistCommission = salePrice * (pharmacistCommission / 100);
  }

  const paymentCommission = salePrice * (paymentRate / 100);

  const netProfit =
    salePrice -
    costPrice -
    shippingCost -
    paymentCommission -
    pharmacistCommission;

  return {
    salePrice,
    costPrice,
    shippingCost,
    paymentCommission,
    pharmacistCommission,
    netProfit
  };
}

/* -------------------------------
   SHOPIFY ÜRÜNLERİNİ SAYFALI OKU
-------------------------------- */

async function fetchShopifyProducts() {
  const allProducts = [];
  const limit = 250;
  let page = 1;

  while (true) {
    const url = `${SHOP_DOMAIN}/products.json?limit=${limit}&page=${page}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error("Shopify ürünleri okunamadı.");
    }

    const data = await response.json();
    const products = Array.isArray(data.products) ? data.products : [];

    if (products.length === 0) break;

    allProducts.push(...products);

    if (products.length < limit) break;

    page++;

    if (page > 20) break;
  }

  return allProducts.map((p) => {
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
        barcode: v.barcode || "",
        price: toNumber(v.price),
        compareAtPrice: toNumber(v.compare_at_price),
        available: Boolean(v.available)
      }))
    };
  });
}

/* -------------------------------
   FİYAT / MALİYET DENETİMİ
-------------------------------- */

function auditProducts(products, costItems, options = {}) {
  const minSuspiciousPrice = Number(options.minSuspiciousPrice || 10);

  const zeroPrice = [];
  const missingImage = [];
  const missingHandle = [];
  const suspiciousLowPrice = [];
  const compareAtProblem = [];
  const variantPriceMismatch = [];

  const missingCost = [];
  const missingPsf = [];
  const belowCost = [];
  const lowProfit = [];
  const belowMinimumSalePrice = [];
  const psfAbove = [];
  const psfBelow = [];

  products.forEach((product) => {
    const cost = matchCostData(product, costItems);
    const profit = cost ? calculateProfit(product, cost) : null;

    const enrichedProduct = {
      ...product,
      cost,
      profit
    };

    if (!product.handle) {
      missingHandle.push(enrichedProduct);
    }

    if (!product.image) {
      missingImage.push(enrichedProduct);
    }

    if (!product.price || product.price <= 0) {
      zeroPrice.push(enrichedProduct);
    }

    if (product.price > 0 && product.price < minSuspiciousPrice) {
      suspiciousLowPrice.push(enrichedProduct);
    }

    if (
      product.compareAtPrice > 0 &&
      product.price > 0 &&
      product.compareAtPrice < product.price
    ) {
      compareAtProblem.push(enrichedProduct);
    }

    const validVariantPrices = product.variants
      .map((v) => v.price)
      .filter((p) => p > 0);

    if (validVariantPrices.length >= 2) {
      const min = Math.min(...validVariantPrices);
      const max = Math.max(...validVariantPrices);

      if (min > 0 && max / min >= 3) {
        variantPriceMismatch.push({
          ...enrichedProduct,
          minVariantPrice: min,
          maxVariantPrice: max
        });
      }
    }

    if (!cost) {
      missingCost.push(enrichedProduct);
      return;
    }

    if (!cost.psf || cost.psf <= 0) {
      missingPsf.push(enrichedProduct);
    }

    if (cost.psf > 0 && product.price > cost.psf) {
      psfAbove.push(enrichedProduct);
    }

    if (cost.psf > 0 && product.price > 0 && product.price < cost.psf) {
      psfBelow.push(enrichedProduct);
    }

    if (cost.minimumSalePrice > 0 && product.price > 0 && product.price < cost.minimumSalePrice) {
      belowMinimumSalePrice.push(enrichedProduct);
    }

    if (profit && product.price > 0 && profit.netProfit < 0) {
      belowCost.push(enrichedProduct);
    }

    if (profit && product.price > 0 && profit.netProfit >= 0 && profit.netProfit < 30) {
      lowProfit.push(enrichedProduct);
    }
  });

  return {
    summary: {
      totalProducts: products.length,
      costRows: costItems.length,
      zeroPriceCount: zeroPrice.length,
      missingImageCount: missingImage.length,
      missingHandleCount: missingHandle.length,
      suspiciousLowPriceCount: suspiciousLowPrice.length,
      compareAtProblemCount: compareAtProblem.length,
      variantPriceMismatchCount: variantPriceMismatch.length,
      missingCostCount: missingCost.length,
      missingPsfCount: missingPsf.length,
      belowCostCount: belowCost.length,
      lowProfitCount: lowProfit.length,
      belowMinimumSalePriceCount: belowMinimumSalePrice.length,
      psfAboveCount: psfAbove.length,
      psfBelowCount: psfBelow.length
    },
    zeroPrice,
    missingImage,
    missingHandle,
    suspiciousLowPrice,
    compareAtProblem,
    variantPriceMismatch,
    missingCost,
    missingPsf,
    belowCost,
    lowProfit,
    belowMinimumSalePrice,
    psfAbove,
    psfBelow
  };
}

/* -------------------------------
   CLAVIS ÜRÜN EŞLEŞTİRME
-------------------------------- */

async function matchProductsFromShopify(answerText) {
  const products = await fetchShopifyProducts();
  const normalizedAnswer = normalizeText(answerText);

  const keywords = [
    "sivilce",
    "akne",
    "yağlı",
    "yagli",
    "karma",
    "gözenek",
    "gozenek",
    "leke",
    "güneş",
    "gunes",
    "spf",
    "hassas",
    "kızarıklık",
    "kizariklik",
    "kuruluk",
    "nem",
    "bariyer",
    "vitamin",
    "takviye",
    "omega",
    "kolajen",
    "saç",
    "sac",
    "bebek",
    "pişik",
    "pisik",
    "medikal",
    "tansiyon",
    "şeker",
    "seker",
    "ateş",
    "ates"
  ];

  const scored = products.map((product) => {
    const searchText = normalizeText(`
      ${product.title}
      ${product.vendor}
      ${product.product_type}
      ${product.tags.join(" ")}
      ${product.body_html}
    `);

    let score = 0;

    keywords.forEach((keyword) => {
      const k = normalizeText(keyword);

      if (normalizedAnswer.includes(k) && searchText.includes(k)) {
        score += 4;
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
   TEMEL ENDPOINTLER
-------------------------------- */

app.get("/", (req, res) => {
  res.json({
    status: "CLAVIS AI backend aktif",
    health: "/health",
    products: "/api/shopify-products",
    priceAudit: "/api/price-audit",
    costSheet: "/api/cost-sheet"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* -------------------------------
   ADMIN ENDPOINTLERİ
-------------------------------- */

app.get("/api/cost-sheet", checkAdminPassword, async (req, res) => {
  try {
    const costItems = await fetchCostSheet();

    return res.json({
      count: costItems.length,
      items: costItems
    });
  } catch (error) {
    console.error("COST SHEET ERROR:", error);
    return res.status(500).json({
      error: "Maliyet tablosu okunamadı."
    });
  }
});

app.get("/api/shopify-products", checkAdminPassword, async (req, res) => {
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

app.get("/api/price-audit", checkAdminPassword, async (req, res) => {
  try {
    const minSuspiciousPrice = req.query.minPrice || 10;
    const products = await fetchShopifyProducts();
    const costItems = await fetchCostSheet();
    const report = auditProducts(products, costItems, { minSuspiciousPrice });

    return res.json(report);
  } catch (error) {
    console.error("PRICE AUDIT ERROR:", error);
    return res.status(500).json({
      error: "Fiyat denetimi yapılamadı."
    });
  }
});

/* -------------------------------
   CLAVIS AI DANIŞMANLIK
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
