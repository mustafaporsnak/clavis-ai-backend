import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";

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
const CLAVIS_SESSION_SECRET =
  process.env.CLAVIS_SESSION_SECRET || "ExpoClavisSession2026";

const TEBRP_ENABLED = String(process.env.TEBRP_ENABLED || "false") === "true";
const TEBRP_API_KEY = process.env.TEBRP_API_KEY || "";
const TEBRP_API_URL = process.env.TEBRP_API_URL || "";

const ADMIN_SESSION_HOURS = 12;

/* -------------------------------
   ADMIN OTURUM / TOKEN
-------------------------------- */

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value) {
  value = String(value || "")
    .replaceAll("-", "+")
    .replaceAll("_", "/");

  while (value.length % 4) value += "=";

  return Buffer.from(value, "base64").toString("utf8");
}

function signPayload(payloadBase64) {
  return crypto
    .createHmac("sha256", CLAVIS_SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function createAdminToken() {
  const payload = {
    role: "admin",
    iat: Date.now(),
    exp: Date.now() + ADMIN_SESSION_HOURS * 60 * 60 * 1000
  };

  const payloadBase64 = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(payloadBase64);

  return `${payloadBase64}.${signature}`;
}

function verifyAdminToken(token) {
  try {
    const raw = String(token || "").trim();
    if (!raw || !raw.includes(".")) return false;

    const [payloadBase64, signature] = raw.split(".");
    const expectedSignature = signPayload(payloadBase64);

    if (signature !== expectedSignature) return false;

    const payload = JSON.parse(base64UrlDecode(payloadBase64));

    if (payload.role !== "admin") return false;
    if (!payload.exp || Date.now() > payload.exp) return false;

    return true;
  } catch {
    return false;
  }
}

function checkPasswordValue(password) {
  const incoming = String(password || "").trim();
  const realPassword = String(CLAVIS_ADMIN_PASSWORD || "").trim();

  if (!realPassword) {
    return {
      ok: false,
      status: 500,
      error: "Admin şifresi Render Environment içinde tanımlı değil."
    };
  }

  if (!incoming || incoming !== realPassword) {
    return {
      ok: false,
      status: 401,
      error: "Yetkisiz erişim. Şifre hatalı veya eksik."
    };
  }

  return { ok: true };
}

function checkAdminAuth(req, res, next) {
  const sessionToken = String(req.headers["x-clavis-session-token"] || "").trim();

  if (verifyAdminToken(sessionToken)) {
    return next();
  }

  // Eski sistem de çalışmaya devam etsin diye bırakıyoruz.
  const password = String(req.headers["x-clavis-admin-password"] || "").trim();
  const passwordCheck = checkPasswordValue(password);

  if (passwordCheck.ok) {
    return next();
  }

  return res.status(passwordCheck.status || 401).json({
    error: passwordCheck.error || "Yetkisiz erişim."
  });
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
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
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

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id || `${item.handle}-${item.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      barcode: String(getField(item, ["barkod", "barcode", "Barkod", "Barcode"]) || "").trim(),
      productName: String(
        getField(item, [
          "ürün adı",
          "urun adı",
          "ürün adi",
          "product name",
          "title",
          "Title"
        ]) || ""
      ).trim(),
      supplyType: String(getField(item, ["tedarik tipi", "supply type"]) || "").trim(),
      costPrice: toNumber(
        getField(item, [
          "geliş fiyatı",
          "gelis fiyati",
          "geliş fiyat",
          "maliyet",
          "cost"
        ])
      ),
      psf: toNumber(getField(item, ["PSF", "psf"])),
      minimumSalePrice: toNumber(
        getField(item, ["minimum satış fiyatı", "minimum satis fiyati"])
      ),
      shippingCost: toNumber(getField(item, ["kargo maliyeti", "kargo"])),
      paymentCommissionRate: toNumber(
        getField(item, ["ödeme komisyonu %", "odeme komisyonu %", "komisyon %"])
      ),
      pharmacistCommission: toNumber(
        getField(item, ["eczacı komisyonu", "eczaci komisyonu"])
      ),
      pharmacistCommissionType: String(
        getField(item, ["eczacı komisyon tipi", "eczaci komisyon tipi"]) || "TL"
      ).trim(),
      targetProfitRate: toNumber(getField(item, ["hedef kâr %", "hedef kar %"])),
      note: String(getField(item, ["not", "Not"]) || "").trim()
    };
  });
}

function matchCostData(product, costItems) {
  const productHandle = normalizeText(product.handle);
  const productTitle = normalizeText(product.title);

  const productSkuList = product.variants
    .map((v) => normalizeText(v.sku))
    .filter(Boolean);

  const productBarcodeList = product.variants
    .map((v) => String(v.barcode || "").trim())
    .filter(Boolean);

  return costItems.find((item) => {
    const itemHandle = normalizeText(item.handle);
    const itemSku = normalizeText(item.sku);
    const itemBarcode = String(item.barcode || "").trim();
    const itemName = normalizeText(item.productName);

    if (itemHandle && itemHandle === productHandle) return true;
    if (itemSku && productSkuList.includes(itemSku)) return true;
    if (itemBarcode && productBarcodeList.includes(itemBarcode)) return true;
    if (itemName && itemName === productTitle) return true;

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
   SHOPIFY ÜRÜNLERİNİ OKU
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

    if (page > 30) break;
  }

  return allProducts.map((p) => {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const firstVariant = variants[0] || {};

    const price = toNumber(firstVariant.price);
    const compareAtPrice = toNumber(firstVariant.compare_at_price);

    const productUrl = `${SHOP_DOMAIN}/products/${p.handle}`;

    return {
      id: p.id,
      title: p.title || "",
      handle: p.handle || "",
      vendor: p.vendor || "",
      product_type: p.product_type || "",
      tags: Array.isArray(p.tags) ? p.tags : [],
      body_html: p.body_html || "",
      url: productUrl,
      adminSearchUrl: `https://admin.shopify.com/store/expo-pharma/products?query=${encodeURIComponent(
        p.title || p.handle || ""
      )}`,
      image:
        p.featured_image ||
        (Array.isArray(p.images) && p.images[0] ? p.images[0].src : ""),
      imageCount: Array.isArray(p.images) ? p.images.length : 0,
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
   TEBRP HAZIR ALTYAPI
-------------------------------- */

async function fetchTebrpByBarcode(barcode) {
  if (!TEBRP_ENABLED) {
    return {
      enabled: false,
      found: false,
      reason: "TEBRP bağlantısı kapalı."
    };
  }

  if (!TEBRP_API_URL || !TEBRP_API_KEY) {
    return {
      enabled: true,
      found: false,
      reason: "TEBRP API URL veya API KEY eksik."
    };
  }

  const url = new URL(TEBRP_API_URL);
  url.searchParams.set("barcode", barcode);
  url.searchParams.set("key", TEBRP_API_KEY);

  const response = await fetch(url.toString(), {
    headers: {
      "x-api-key": TEBRP_API_KEY
    }
  });

  if (!response.ok) {
    throw new Error("TEBRP verisi alınamadı.");
  }

  const data = await response.json();

  return {
    enabled: true,
    found: true,
    raw: data
  };
}

/* -------------------------------
   DENETİM
-------------------------------- */

function makeOperationRow(product, cost = null, profit = null, extra = {}) {
  const firstVariant = product.variants?.[0] || {};
  const psf = Number(cost?.psf || 0);
  const recommendedPrice = psf > 0 ? Math.round(psf * 0.95 * 100) / 100 : 0;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor,
    product_type: product.product_type,
    url: product.url,
    adminSearchUrl: product.adminSearchUrl,
    image: product.image,
    imageCount: product.imageCount,
    available: product.available,

    sku: firstVariant.sku || "",
    barcode: firstVariant.barcode || "",

    shopifyPrice: product.price,
    compareAtPrice: product.compareAtPrice,

    psf,
    recommendedPrice,

    costPrice: Number(cost?.costPrice || 0),
    minimumSalePrice: Number(cost?.minimumSalePrice || 0),
    shippingCost: Number(cost?.shippingCost || 0),
    paymentCommissionRate: Number(cost?.paymentCommissionRate || 0),
    targetProfitRate: Number(cost?.targetProfitRate || 0),

    netProfit: profit ? Math.round(profit.netProfit * 100) / 100 : null,

    costMatched: Boolean(cost),
    note: cost?.note || "",
    ...extra
  };
}

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
  const missingBarcode = [];
  const belowCost = [];
  const lowProfit = [];
  const belowMinimumSalePrice = [];
  const psfAbove = [];
  const psfBelow = [];

  products.forEach((product) => {
    const cost = matchCostData(product, costItems);
    const profit = cost ? calculateProfit(product, cost) : null;
    const row = makeOperationRow(product, cost, profit);

    const allBarcodes = product.variants.map((v) => v.barcode).filter(Boolean);

    if (!product.handle) {
      missingHandle.push(row);
    }

    if (!product.image) {
      missingImage.push(row);
    }

    if (!product.price || product.price <= 0) {
      zeroPrice.push(row);
    }

    if (allBarcodes.length === 0) {
      missingBarcode.push(row);
    }

    if (product.price > 0 && product.price < minSuspiciousPrice) {
      suspiciousLowPrice.push(row);
    }

    if (
      product.compareAtPrice > 0 &&
      product.price > 0 &&
      product.compareAtPrice < product.price
    ) {
      compareAtProblem.push(row);
    }

    const validVariantPrices = product.variants
      .map((v) => v.price)
      .filter((p) => p > 0);

    if (validVariantPrices.length >= 2) {
      const min = Math.min(...validVariantPrices);
      const max = Math.max(...validVariantPrices);

      if (min > 0 && max / min >= 3) {
        variantPriceMismatch.push({
          ...row,
          minVariantPrice: min,
          maxVariantPrice: max
        });
      }
    }

    if (!cost) {
      missingCost.push(row);
      return;
    }

    if (!cost.psf || cost.psf <= 0) {
      missingPsf.push(row);
    }

    if (cost.psf > 0 && product.price > cost.psf) {
      psfAbove.push(row);
    }

    if (cost.psf > 0 && product.price > 0 && product.price < cost.psf) {
      psfBelow.push(row);
    }

    if (
      cost.minimumSalePrice > 0 &&
      product.price > 0 &&
      product.price < cost.minimumSalePrice
    ) {
      belowMinimumSalePrice.push(row);
    }

    if (profit && product.price > 0 && profit.netProfit < 0) {
      belowCost.push(row);
    }

    if (profit && product.price > 0 && profit.netProfit >= 0 && profit.netProfit < 30) {
      lowProfit.push(row);
    }
  });

  return {
    summary: {
      totalProducts: products.length,
      costRows: costItems.length,

      zeroPriceCount: zeroPrice.length,
      missingImageCount: missingImage.length,
      missingHandleCount: missingHandle.length,
      missingBarcodeCount: missingBarcode.length,

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

    zeroPrice: uniqueById(zeroPrice),
    missingImage: uniqueById(missingImage),
    missingHandle: uniqueById(missingHandle),
    missingBarcode: uniqueById(missingBarcode),

    suspiciousLowPrice: uniqueById(suspiciousLowPrice),
    compareAtProblem: uniqueById(compareAtProblem),
    variantPriceMismatch: uniqueById(variantPriceMismatch),

    missingCost: uniqueById(missingCost),
    missingPsf: uniqueById(missingPsf),

    belowCost: uniqueById(belowCost),
    lowProfit: uniqueById(lowProfit),
    belowMinimumSalePrice: uniqueById(belowMinimumSalePrice),

    psfAbove: uniqueById(psfAbove),
    psfBelow: uniqueById(psfBelow)
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
    login: "/api/admin-login",
    session: "/api/admin-session",
    products: "/api/shopify-products",
    priceAudit: "/api/price-audit",
    operations: "/api/product-operations",
    costSheet: "/api/cost-sheet"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* -------------------------------
   ADMIN LOGIN ENDPOINTLERİ
-------------------------------- */

app.post("/api/admin-login", (req, res) => {
  const password =
    req.body?.password ||
    req.headers["x-clavis-admin-password"] ||
    "";

  const passwordCheck = checkPasswordValue(password);

  if (!passwordCheck.ok) {
    return res.status(passwordCheck.status || 401).json({
      ok: false,
      error: passwordCheck.error
    });
  }

  const token = createAdminToken();

  return res.json({
    ok: true,
    token,
    expiresInHours: ADMIN_SESSION_HOURS
  });
});

app.get("/api/admin-session", checkAdminAuth, (req, res) => {
  return res.json({
    ok: true,
    authenticated: true
  });
});

/* -------------------------------
   ADMIN VERİ ENDPOINTLERİ
-------------------------------- */

app.get("/api/cost-sheet", checkAdminAuth, async (req, res) => {
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

app.get("/api/shopify-products", checkAdminAuth, async (req, res) => {
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

app.get("/api/price-audit", checkAdminAuth, async (req, res) => {
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

app.get("/api/product-operations", checkAdminAuth, async (req, res) => {
  try {
    const products = await fetchShopifyProducts();
    const costItems = await fetchCostSheet();
    const report = auditProducts(products, costItems);

    return res.json({
      summary: report.summary,
      sections: {
        zeroPrice: {
          title: "Fiyatı 0 / boş olan ürünler",
          count: report.zeroPrice.length,
          items: report.zeroPrice
        },
        missingCost: {
          title: "Maliyet bilgisi eksik ürünler",
          count: report.missingCost.length,
          items: report.missingCost
        },
        missingPsf: {
          title: "PSF eksik ürünler",
          count: report.missingPsf.length,
          items: report.missingPsf
        },
        missingImage: {
          title: "Görseli eksik ürünler",
          count: report.missingImage.length,
          items: report.missingImage
        },
        missingBarcode: {
          title: "Barkodu eksik ürünler",
          count: report.missingBarcode.length,
          items: report.missingBarcode
        },
        psfAbove: {
          title: "PSF üstünde satışta olan ürünler",
          count: report.psfAbove.length,
          items: report.psfAbove
        },
        psfBelow: {
          title: "PSF altında satışta olan ürünler",
          count: report.psfBelow.length,
          items: report.psfBelow
        },
        belowCost: {
          title: "Zarar riski olan ürünler",
          count: report.belowCost.length,
          items: report.belowCost
        }
      }
    });
  } catch (error) {
    console.error("PRODUCT OPERATIONS ERROR:", error);
    return res.status(500).json({
      error: "Ürün operasyon paneli oluşturulamadı."
    });
  }
});

app.get("/api/tebrp/barcode/:barcode", checkAdminAuth, async (req, res) => {
  try {
    const barcode = String(req.params.barcode || "").trim();

    if (!barcode) {
      return res.status(400).json({
        error: "Barkod eksik."
      });
    }

    const result = await fetchTebrpByBarcode(barcode);

    return res.json(result);
  } catch (error) {
    console.error("TEBRP ERROR:", error);
    return res.status(500).json({
      error: "TEBRP verisi alınamadı."
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
