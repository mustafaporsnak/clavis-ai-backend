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

/* -------------------------------
   SABİTLER
-------------------------------- */

const SHOP_DOMAIN = "https://www.expo-pharma.com";

const CLAVIS_ADMIN_PASSWORD = process.env.CLAVIS_ADMIN_PASSWORD;
const CLAVIS_SHEET_URL = process.env.CLAVIS_SHEET_URL;

const SHOPIFY_SHOP_NAME = process.env.SHOPIFY_SHOP_NAME;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

let cachedShopifyToken = null;
let cachedShopifyTokenExpiresAt = 0;

/* -------------------------------
   ADMIN OTURUM SİSTEMİ
-------------------------------- */

function getSessionSecret() {
  return String(
    process.env.CLAVIS_SESSION_SECRET ||
      process.env.CLAVIS_ADMIN_PASSWORD ||
      "clavis-fallback-secret"
  );
}

function signToken(payloadBase64) {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(payloadBase64)
    .digest("hex");
}

function createSessionToken() {
  const payload = {
    role: "admin",
    exp: Date.now() + 12 * 60 * 60 * 1000
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = signToken(payloadBase64);

  return `${payloadBase64}.${signature}`;
}

function verifySessionToken(token) {
  try {
    const [payloadBase64, signature] = String(token || "").split(".");

    if (!payloadBase64 || !signature) return false;

    const expectedSignature = signToken(payloadBase64);

    if (signature !== expectedSignature) return false;

    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));

    if (!payload.exp || Date.now() > payload.exp) return false;

    return true;
  } catch {
    return false;
  }
}

function checkAdminPassword(req, res, next) {
  const sessionToken = String(req.headers["x-clavis-session-token"] || "").trim();

  if (sessionToken && verifySessionToken(sessionToken)) {
    return next();
  }

  const password = String(req.headers["x-clavis-admin-password"] || "").trim();
  const realPassword = String(CLAVIS_ADMIN_PASSWORD || "").trim();

  if (!realPassword) {
    return res.status(500).json({
      error: "Admin şifresi Render Environment içinde tanımlı değil."
    });
  }

  if (!password || password !== realPassword) {
    return res.status(401).json({
      error: "Yetkisiz erişim. Şifre hatalı, eksik veya oturum süresi dolmuş."
    });
  }

  return next();
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
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const cleaned = String(value || "")
    .replace("TL", "")
    .replace("₺", "")
    .replaceAll(".", "")
    .replace(",", ".")
    .replace("%", "")
    .trim();

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(value) {
  const n = Number(value || 0);
  return Math.round(n * 100) / 100;
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

function makeAdminSearchUrl(title) {
  return `https://admin.shopify.com/store/${SHOPIFY_SHOP_NAME || "expo-pharma"}/products?query=${encodeURIComponent(
    title || ""
  )}`;
}

function makeShopUrl(handle) {
  return `${SHOP_DOMAIN}/products/${handle || ""}`;
}

/* -------------------------------
   SHOPIFY ADMIN API
-------------------------------- */

async function getShopifyAccessToken() {
  if (SHOPIFY_ADMIN_ACCESS_TOKEN) {
    return SHOPIFY_ADMIN_ACCESS_TOKEN;
  }

  const now = Date.now();

  if (cachedShopifyToken && cachedShopifyTokenExpiresAt > now + 60000) {
    return cachedShopifyToken;
  }

  if (!SHOPIFY_SHOP_NAME || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error("Shopify Client ID, Secret veya Shop Name eksik.");
  }

  const tokenUrl = `https://${SHOPIFY_SHOP_NAME}.myshopify.com/admin/oauth/access_token`;

  const body = JSON.stringify({
  grant_type: "client_credentials",
  client_id: SHOPIFY_CLIENT_ID,
  client_secret: SHOPIFY_CLIENT_SECRET
});

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
  "Content-Type": "application/json"
},
body
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    console.error("SHOPIFY TOKEN ERROR:", data);
    throw new Error("Shopify access token alınamadı.");
  }

  cachedShopifyToken = data.access_token;
  cachedShopifyTokenExpiresAt =
    Date.now() + Number(data.expires_in || 86000) * 1000;

  return cachedShopifyToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const token = await getShopifyAccessToken();

  const response = await fetch(
    `https://${SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.errors) {
    console.error("SHOPIFY GRAPHQL ERROR:", JSON.stringify(data, null, 2));
    throw new Error("Shopify Admin API sorgusu başarısız.");
  }

  return data.data;
}

async function fetchShopifyAdminProducts() {
  const allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const data = await shopifyGraphQL(
      `
      query GetProducts($cursor: String) {
        products(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
              vendor
              productType
              status
              tags
              featuredImage {
                url
              }
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    barcode
                    price
                    compareAtPrice
                    inventoryItem {
                      id
                      tracked
                      unitCost {
                        amount
                        currencyCode
                      }
                    }
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }
      `,
      { cursor }
    );

    const products = data.products.edges.map((edge) => edge.node);
    allProducts.push(...products);

    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;

    if (allProducts.length > 5000) break;
  }

  return allProducts.map((p) => {
    const variants = Array.isArray(p.variants?.edges)
      ? p.variants.edges.map((e) => e.node)
      : [];

    const firstVariant = variants[0] || {};

    const price = toNumber(firstVariant.price);
    const compareAtPrice = toNumber(firstVariant.compareAtPrice);

    return {
      id: p.id,
      title: p.title || "",
      handle: p.handle || "",
      vendor: p.vendor || "",
      product_type: p.productType || "",
      status: p.status || "",
      tags: Array.isArray(p.tags) ? p.tags : [],
      url: makeShopUrl(p.handle),
      adminSearchUrl: makeAdminSearchUrl(p.title),
      image: p.featuredImage?.url || "",
      available: Number(firstVariant.inventoryQuantity || 0) > 0,
      price,
      compareAtPrice,
      variants: variants.map((v) => ({
        id: v.id,
        title: v.title || "",
        sku: v.sku || "",
        barcode: v.barcode || "",
        price: toNumber(v.price),
        compareAtPrice: toNumber(v.compareAtPrice),
        inventoryItemId: v.inventoryItem?.id || "",
        inventoryTracked: Boolean(v.inventoryItem?.tracked),
        inventoryQuantity: Number(v.inventoryQuantity || 0),
        unitCost: toNumber(v.inventoryItem?.unitCost?.amount)
      }))
    };
  });
}

/* -------------------------------
   PUBLIC SHOPIFY FALLBACK
-------------------------------- */

async function fetchShopifyPublicProducts() {
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

    return {
      id: p.id,
      title: p.title || "",
      handle: p.handle || "",
      vendor: p.vendor || "",
      product_type: p.product_type || "",
      status: "",
      tags: Array.isArray(p.tags) ? p.tags : [],
      body_html: p.body_html || "",
      url: makeShopUrl(p.handle),
      adminSearchUrl: makeAdminSearchUrl(p.title),
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
        available: Boolean(v.available),
        inventoryItemId: "",
        inventoryTracked: false,
        inventoryQuantity: 0,
        unitCost: 0
      }))
    };
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
    const costPrice = toNumber(
      getField(item, [
        "geliş fiyatı",
        "gelis fiyati",
        "geliş fiyat",
        "gelis fiyat",
        "maliyet",
        "cost",
        "Cost"
      ])
    );

    const psf = toNumber(getField(item, ["PSF", "psf"]));

    const recommendedPrice = toNumber(
      getField(item, [
        "Shopify satış fiyatı",
        "shopify satış fiyatı",
        "shopify satis fiyati",
        "önerilen fiyat",
        "onerilen fiyat"
      ])
    );

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
          "Title",
          "Ürün"
        ]) || ""
      ).trim(),
      supplyType: String(getField(item, ["tedarik tipi", "supply type"]) || "").trim(),
      costPrice,
      psf,
      recommendedPrice,
      compareAtPrice: psf,
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

/* -------------------------------
   EŞLEŞTİRME VE HESAPLAMA
-------------------------------- */

function matchCostData(product, costItems) {
  const productHandle = normalizeText(product.handle);
  const productTitle = normalizeText(product.title);

  const productSkuList = product.variants
    .map((v) => normalizeText(v.sku))
    .filter(Boolean);

  const productBarcodeList = product.variants
    .map((v) => normalizeText(v.barcode))
    .filter(Boolean);

  let match = costItems.find((item) => {
    const itemBarcode = normalizeText(item.barcode);
    return itemBarcode && productBarcodeList.includes(itemBarcode);
  });

  if (match) return match;

  match = costItems.find((item) => {
    const itemSku = normalizeText(item.sku);
    return itemSku && productSkuList.includes(itemSku);
  });

  if (match) return match;

  match = costItems.find((item) => {
    const itemHandle = normalizeText(item.handle);
    return itemHandle && itemHandle === productHandle;
  });

  if (match) return match;

  match = costItems.find((item) => {
    const itemName = normalizeText(item.productName);
    return itemName && itemName === productTitle;
  });

  if (match) return match;

  match = costItems.find((item) => {
    const itemName = normalizeText(item.productName);

    if (!itemName || !productTitle) return false;

    if (itemName.length > 8 && productTitle.includes(itemName)) return true;
    if (productTitle.length > 8 && itemName.includes(productTitle)) return true;

    return false;
  });

  return match || null;
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
    netProfit: roundMoney(netProfit)
  };
}

function productToOperationRow(product, cost = null, profit = null) {
  const firstVariant = product.variants[0] || {};
  const barcode = firstVariant.barcode || cost?.barcode || "";
  const sku = firstVariant.sku || cost?.sku || "";

  const psf = Number(cost?.psf || 0);
  const recommendedPrice =
    Number(cost?.recommendedPrice || 0) ||
    (psf > 0 ? roundMoney(psf * 0.95) : 0);

  return {
    id: product.id,
    variantId: firstVariant.id || "",
    inventoryItemId: firstVariant.inventoryItemId || "",
    title: product.title,
    vendor: product.vendor,
    handle: product.handle,
    status: product.status,
    barcode,
    sku,
    shopifyPrice: Number(product.price || 0),
    price: Number(product.price || 0),
    compareAtPrice: Number(product.compareAtPrice || 0),
    psf,
    recommendedPrice,
    costPrice: Number(cost?.costPrice || firstVariant.unitCost || 0),
    minimumSalePrice: Number(cost?.minimumSalePrice || 0),
    netProfit: profit ? profit.netProfit : null,
    image: product.image || "",
    url: product.url,
    adminSearchUrl: product.adminSearchUrl,
    inventoryTracked: Boolean(firstVariant.inventoryTracked),
    inventoryQuantity: Number(firstVariant.inventoryQuantity || 0),
    note: cost?.note || ""
  };
}

/* -------------------------------
   DENETİM RAPORU
-------------------------------- */

function auditProducts(products, costItems, options = {}) {
  const minSuspiciousPrice = Number(options.minSuspiciousPrice || 10);

  const zeroPrice = [];
  const missingImage = [];
  const missingHandle = [];
  const missingBarcode = [];
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
    const row = productToOperationRow(product, cost, profit);

    if (!product.handle) {
      missingHandle.push(row);
    }

    if (!product.image) {
      missingImage.push(row);
    }

    const hasAnyBarcode = product.variants.some((v) => String(v.barcode || "").trim());

    if (!hasAnyBarcode) {
      missingBarcode.push(row);
    }

    if (!product.price || product.price <= 0) {
      zeroPrice.push(row);
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

    zeroPrice,
    missingImage,
    missingHandle,
    missingBarcode,
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

function buildOperationSections(report) {
  return {
    zeroPrice: {
      title: "Fiyatı 0 / boş görünen ürünler",
      count: report.zeroPrice.length,
      items: report.zeroPrice
    },
    missingCost: {
      title: "Maliyet bilgisi eksik ürünler",
      count: report.missingCost.length,
      items: report.missingCost
    },
    missingPsf: {
      title: "PSF bilgisi eksik ürünler",
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
  };
}

/* -------------------------------
   CLAVIS ÜRÜN EŞLEŞTİRME
-------------------------------- */

async function matchProductsFromShopify(answerText) {
  let products = [];

  try {
    products = await fetchShopifyAdminProducts();
  } catch {
    products = await fetchShopifyPublicProducts();
  }

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
    adminLogin: "/api/admin-login",
    adminSession: "/api/admin-session",
    shopifyAdminTest: "/api/shopify-admin-test",
    productOperations: "/api/product-operations",
    priceAudit: "/api/price-audit",
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
  const password = String(req.body?.password || "").trim();
  const realPassword = String(CLAVIS_ADMIN_PASSWORD || "").trim();

  if (!realPassword) {
    return res.status(500).json({
      error: "Admin şifresi Render Environment içinde tanımlı değil."
    });
  }

  if (!password || password !== realPassword) {
    return res.status(401).json({
      error: "Şifre hatalı."
    });
  }

  return res.json({
    status: "ok",
    token: createSessionToken()
  });
});

app.get("/api/admin-session", checkAdminPassword, (req, res) => {
  return res.json({
    status: "ok"
  });
});

/* -------------------------------
   ADMIN ENDPOINTLERİ
-------------------------------- */

app.get("/api/shopify-admin-test", checkAdminPassword, async (req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query {
        shop {
          name
          myshopifyDomain
        }
        products(first: 1) {
          edges {
            node {
              id
              title
              handle
              variants(first: 1) {
                edges {
                  node {
                    id
                    sku
                    barcode
                    price
                    compareAtPrice
                    inventoryItem {
                      id
                      tracked
                      unitCost {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `);

    return res.json({
      status: "ok",
      shop: data.shop,
      sampleProduct: data.products.edges[0]?.node || null
    });
  } catch (error) {
    console.error("SHOPIFY ADMIN TEST ERROR:", error);
    return res.status(500).json({
      error: error.message || "Shopify Admin API test başarısız."
    });
  }
});

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
    let products = [];

    try {
      products = await fetchShopifyAdminProducts();
    } catch (adminError) {
      console.error("ADMIN SHOPIFY READ FAILED, FALLBACK PUBLIC:", adminError);
      products = await fetchShopifyPublicProducts();
    }

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

    let products = [];

    try {
      products = await fetchShopifyAdminProducts();
    } catch (adminError) {
      console.error("ADMIN SHOPIFY READ FAILED, FALLBACK PUBLIC:", adminError);
      products = await fetchShopifyPublicProducts();
    }

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

app.get("/api/product-operations", checkAdminPassword, async (req, res) => {
  try {
    let source = "admin-api";
    let products = [];

    try {
      products = await fetchShopifyAdminProducts();
    } catch (adminError) {
      console.error("ADMIN SHOPIFY READ FAILED, FALLBACK PUBLIC:", adminError);
      source = "public-products-json";
      products = await fetchShopifyPublicProducts();
    }

    const costItems = await fetchCostSheet();
    const report = auditProducts(products, costItems);

    return res.json({
      source,
      summary: report.summary,
      sections: buildOperationSections(report)
    });
  } catch (error) {
    console.error("PRODUCT OPERATIONS ERROR:", error);
    return res.status(500).json({
      error: "Ürün operasyon raporu oluşturulamadı."
    });
  }
});

/* -------------------------------
   SHOPIFY YAZMA ENDPOINTLERİ
-------------------------------- */

app.post("/api/update-variant-basic", checkAdminPassword, async (req, res) => {
  try {
    const {
      variantId,
      price,
      compareAtPrice,
      barcode,
      sku
    } = req.body || {};

    if (!variantId) {
      return res.status(400).json({
        error: "variantId eksik."
      });
    }

    const input = {
      id: variantId
    };

    if (price !== undefined && price !== null && price !== "") {
      input.price = String(roundMoney(toNumber(price)));
    }

    if (compareAtPrice !== undefined && compareAtPrice !== null && compareAtPrice !== "") {
      input.compareAtPrice = String(roundMoney(toNumber(compareAtPrice)));
    }

    if (barcode !== undefined) {
      input.barcode = String(barcode || "").trim();
    }

    if (sku !== undefined) {
      input.sku = String(sku || "").trim();
    }

    const data = await shopifyGraphQL(
      `
      mutation productVariantUpdate($input: ProductVariantInput!) {
        productVariantUpdate(input: $input) {
          productVariant {
            id
            price
            compareAtPrice
            barcode
            sku
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      { input }
    );

    const errors = data.productVariantUpdate.userErrors || [];

    if (errors.length) {
      return res.status(400).json({
        error: errors.map((e) => e.message).join(", ")
      });
    }

    return res.json({
      status: "ok",
      variant: data.productVariantUpdate.productVariant
    });
  } catch (error) {
    console.error("UPDATE VARIANT ERROR:", error);
    return res.status(500).json({
      error: error.message || "Varyant güncellenemedi."
    });
  }
});

app.post("/api/update-inventory-item", checkAdminPassword, async (req, res) => {
  try {
    const {
      inventoryItemId,
      tracked,
      cost
    } = req.body || {};

    if (!inventoryItemId) {
      return res.status(400).json({
        error: "inventoryItemId eksik."
      });
    }

    const input = {};

    if (tracked !== undefined) {
      input.tracked = Boolean(tracked);
    }

    if (cost !== undefined && cost !== null && cost !== "") {
      input.cost = String(roundMoney(toNumber(cost)));
    }

    const data = await shopifyGraphQL(
      `
      mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          inventoryItem {
            id
            tracked
            unitCost {
              amount
              currencyCode
            }
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      {
        id: inventoryItemId,
        input
      }
    );

    const errors = data.inventoryItemUpdate.userErrors || [];

    if (errors.length) {
      return res.status(400).json({
        error: errors.map((e) => e.message).join(", ")
      });
    }

    return res.json({
      status: "ok",
      inventoryItem: data.inventoryItemUpdate.inventoryItem
    });
  } catch (error) {
    console.error("UPDATE INVENTORY ITEM ERROR:", error);
    return res.status(500).json({
      error: error.message || "Inventory item güncellenemedi."
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
