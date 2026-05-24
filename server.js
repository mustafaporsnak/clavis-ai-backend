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

const SHOPIFY_SHOP_NAME = process.env.SHOPIFY_SHOP_NAME;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const VAKIFBANK_MERCHANT_ID = process.env.VAKIFBANK_MERCHANT_ID;
const VAKIFBANK_TERMINAL_ID = process.env.VAKIFBANK_TERMINAL_ID;
const VAKIFBANK_API_PASSWORD = process.env.VAKIFBANK_API_PASSWORD;

const CLAVIS_MODEL = process.env.CLAVIS_MODEL || "gpt-5.5";

let cachedShopifyToken = null;
let cachedShopifyTokenExpiresAt = 0;

/* -------------------------------
   ADMIN OTURUM
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

function productHasTag(product, tag) {
  const wanted = String(tag || "").toLowerCase().trim();

  return (product.tags || []).some((t) => {
    return String(t || "").toLowerCase().trim() === wanted;
  });
}

/* -------------------------------
   SHOPIFY API
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

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET
    })
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

async function shopifyRest(path, options = {}) {
  const token = await getShopifyAccessToken();

  const response = await fetch(
    `https://${SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}${path}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
        ...(options.headers || {})
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("SHOPIFY REST ERROR:", JSON.stringify(data, null, 2));
    throw new Error(
      data.errors
        ? typeof data.errors === "string"
          ? data.errors
          : JSON.stringify(data.errors)
        : "Shopify REST işlemi başarısız."
    );
  }

  return data;
}

/* -------------------------------
   SHOPIFY ÜRÜN OKUMA
-------------------------------- */

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
                    inventoryQuantity
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
      available:
        String(p.status || "").toUpperCase() === "ACTIVE" &&
        Number(firstVariant.inventoryQuantity || 0) > 0,
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
        id: String(v.id || ""),
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
   GOOGLE SHEET MALİYET / PSF
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

    const psf = toNumber(getField(item, ["PSF", "psf", "Psf"]));

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
   EŞLEŞTİRME / HESAP
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

  const psf =
    Number(cost?.psf || 0) ||
    Number(product.compareAtPrice || 0) ||
    Number(firstVariant.compareAtPrice || 0);

  const recommendedPrice =
    Number(cost?.recommendedPrice || 0) ||
    (psf > 0 ? roundMoney(psf * 0.95) : 0);

  return {
    id: product.id,
    productId: product.id,
    variantId: firstVariant.id || "",
    inventoryItemId: firstVariant.inventoryItemId || "",
    title: product.title,
    vendor: product.vendor,
    handle: product.handle,
    status: product.status,
    isActive: String(product.status || "").toUpperCase() === "ACTIVE",
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
   DENETİM
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

    if (!product.handle) missingHandle.push(row);
    if (!product.image) missingImage.push(row);

    const hasAnyBarcode = product.variants.some((v) => String(v.barcode || "").trim());
    if (!hasAnyBarcode) missingBarcode.push(row);

    if (!product.price || product.price <= 0) zeroPrice.push(row);

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
      if (!row.psf || row.psf <= 0) missingPsf.push(row);
      return;
    }

    if (!row.psf || row.psf <= 0) missingPsf.push(row);

    if (row.psf > 0 && product.price > row.psf) psfAbove.push(row);

    if (row.psf > 0 && product.price > 0 && product.price < row.psf) {
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
   CLAVIS AI MOTOR
-------------------------------- */

async function createAdviceStrategy(answerText) {
  const prompt = `
Sen Expo Pharma'nın eczacı destekli ürün danışmanlığı motorusun.

Görevin:
Kullanıcının verdiği cevapları anlayıp ürün önerisi için strateji çıkarmak.

Çok önemli:
- Tanı koyma.
- Tedavi iddiası oluşturma.
- Ürün seçimini mekanik etiket eşleşmesi gibi yapma.
- Önce ihtiyacı eczacı mantığıyla yorumla.
- Ürün rutini mantığı kur.
- Sadece JSON döndür.

Kategori etiketleri:
cat_dermokozmetik
cat_vitamin_takviye
cat_anne_bebek
cat_medikal
cat_saglik_yasam
cat_kisisel_bakim

Dermokozmetik ihtiyaç etiketleri:
need_akne
need_leke
need_nem
need_hassas_cilt
need_gunes_koruma

Cilt tipi etiketleri:
skin_yagli
skin_kuru
skin_karma
skin_hassas

Alt kategori/form etiketleri:
sub_cilt_temizleyici
sub_gunes_koruyucu
sub_omega3
sub_kolajen
sub_magnezyum
sub_probiyotik
sub_tansiyon
sub_seker_olcum
form_gel
form_krem
form_serum

Kullanıcı cevapları:
${answerText}

JSON formatı:
{
  "mainCategory": "cat_dermokozmetik",
  "problemSummary": "Kısa ihtiyaç özeti",
  "detectedNeeds": ["need_akne"],
  "detectedSkinTypes": ["skin_yagli"],
  "preferredTags": ["cat_dermokozmetik", "need_akne", "skin_yagli", "sub_cilt_temizleyici"],
  "avoidTags": ["need_hassas_cilt"],
  "routineSlots": [
    {
      "slot": "cleanser",
      "title": "Temizleyici",
      "priority": 1,
      "desiredTags": ["sub_cilt_temizleyici", "form_gel", "skin_yagli"]
    }
  ],
  "searchKeywords": ["akne", "sivilce", "siyah nokta", "yağlı cilt"],
  "redFlags": [],
  "adviceTone": "Profesyonel, doğal, eczacı dili"
}
`;

  const response = await client.responses.create({
    model: CLAVIS_MODEL,
    input: prompt
  });

  const parsed = safeJsonParse(response.output_text);

  if (!parsed || !parsed.mainCategory) {
    return {
      mainCategory: "cat_dermokozmetik",
      problemSummary: "Kullanıcının ihtiyacına göre genel ürün danışmanlığı.",
      detectedNeeds: [],
      detectedSkinTypes: [],
      preferredTags: [],
      avoidTags: [],
      routineSlots: [],
      searchKeywords: [],
      redFlags: [],
      adviceTone: "Profesyonel, doğal, eczacı dili"
    };
  }

  return parsed;
}

async function getCandidateProductsByStrategy(strategy) {
  let products = [];

  try {
    products = await fetchShopifyAdminProducts();
  } catch {
    products = await fetchShopifyPublicProducts();
  }

  const preferredTags = Array.isArray(strategy.preferredTags) ? strategy.preferredTags : [];
  const avoidTags = Array.isArray(strategy.avoidTags) ? strategy.avoidTags : [];
  const searchKeywords = Array.isArray(strategy.searchKeywords) ? strategy.searchKeywords : [];
  const mainCategory = strategy.mainCategory || "";

  const routineSlots = Array.isArray(strategy.routineSlots) ? strategy.routineSlots : [];
  const routineTags = routineSlots.flatMap((slot) =>
    Array.isArray(slot.desiredTags) ? slot.desiredTags : []
  );

  const scored = products.map((product) => {
    const searchText = normalizeText(`
      ${product.title}
      ${product.vendor}
      ${product.product_type}
      ${(product.tags || []).join(" ")}
    `);

    let score = 0;

    if (mainCategory) {
      if (productHasTag(product, mainCategory)) score += 90;
      else score -= 140;
    }

    preferredTags.forEach((tag) => {
      if (productHasTag(product, tag)) score += 20;
    });

    routineTags.forEach((tag) => {
      if (productHasTag(product, tag)) score += 14;
    });

    avoidTags.forEach((tag) => {
      if (productHasTag(product, tag)) score -= 25;
    });

    searchKeywords.forEach((keyword) => {
      const k = normalizeText(keyword);
      if (k && searchText.includes(k)) score += 10;
    });

    if (product.available) score += 5;
    if (product.price > 0) score += 4;
    if (product.image) score += 2;

    return { ...product, score };
  });

  return scored
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
}

async function rankProductsWithAI(strategy, candidateProducts) {
  if (!candidateProducts.length) return [];

  const compactProducts = candidateProducts.map((p, index) => ({
    index,
    id: p.id,
    title: p.title,
    vendor: p.vendor,
    product_type: p.product_type,
    tags: p.tags,
    price: p.price,
    available: p.available,
    url: p.url,
    image: p.image
  }));

  const prompt = `
Sen Expo Pharma'nın eczacı destekli ürün seçim danışmanısın.

Görevin:
Verilen stratejiye göre aday ürünler arasından en mantıklı ürünleri seçmek ve sıraya koymak.

Çok önemli:
- Sadece verilen aday ürünlerden seçim yap.
- Ürün uydurma.
- Tanı koyma.
- Tedavi eder gibi kesin iddia kurma.
- Ürünleri bakım/ürün rutini mantığıyla sırala.
- Aynı role sahip gereksiz benzer ürünleri seçme.
- En fazla 4 ürün seç.
- Ürün yoksa boş liste döndür.

Strateji:
${JSON.stringify(strategy, null, 2)}

Aday ürünler:
${JSON.stringify(compactProducts, null, 2)}

JSON formatı:
{
  "selected": [
    {
      "index": 0,
      "role": "Temizleyici",
      "reason": "Yağlı ve akneye eğilimli ciltlerde ilk adım olarak değerlendirilebilir."
    }
  ]
}
`;

  const response = await client.responses.create({
    model: CLAVIS_MODEL,
    input: prompt
  });

  const parsed = safeJsonParse(response.output_text);

  if (!parsed || !Array.isArray(parsed.selected)) {
    return [];
  }

  return parsed.selected
    .map((selected) => {
      const product = candidateProducts[selected.index];
      if (!product) return null;

      return {
        ...product,
        clavisRole: selected.role || "Ürün önerisi",
        clavisReason: selected.reason || "Verdiğiniz bilgilere göre değerlendirilebilir."
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

async function matchProductsFromShopify(answerText) {
  const strategy = await createAdviceStrategy(answerText);
  const candidates = await getCandidateProductsByStrategy(strategy);
  const selectedProducts = await rankProductsWithAI(strategy, candidates);

  return {
    strategy,
    products: selectedProducts
  };
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
    shopifyProducts: "/api/shopify-products",
    adminProductsFull: "/api/admin-products-full",
    productOperations: "/api/product-operations",
    priceAudit: "/api/price-audit",
    costSheet: "/api/cost-sheet",
    updateVariant: "/api/update-variant-basic",
    updateInventoryItem: "/api/update-inventory-item",
    updateProductStatus: "/api/update-product-status",
    bulkProductAction: "/api/bulk-product-action"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
app.get("/api/vakifbank-config-test", (req, res) => {
  return res.json({
    status: "ok",
    merchantIdExists: Boolean(VAKIFBANK_MERCHANT_ID),
    terminalIdExists: Boolean(VAKIFBANK_TERMINAL_ID),
    apiPasswordExists: Boolean(VAKIFBANK_API_PASSWORD),
    merchantIdLast4: VAKIFBANK_MERCHANT_ID
      ? String(VAKIFBANK_MERCHANT_ID).slice(-4)
      : null,
    terminalId: VAKIFBANK_TERMINAL_ID || null
  });
});
function makeVakifbankPaymentUrl(order) {
  const orderId = order.id || "";
  const orderName = String(order.name || "").replace("#", "");
  const amount = order.total_price || "0";

  return `https://clavis-ai-backend.onrender.com/pay/vakifbank?orderId=${encodeURIComponent(orderId)}&orderName=${encodeURIComponent(orderName)}&amount=${encodeURIComponent(amount)}`;
}

app.get("/pay/vakifbank", (req, res) => {
  const orderName = req.query.orderName || "";
  const amount = req.query.amount || "";

  res.send(`
    <html>
      <head>
        <title>Güvenli Ödeme</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family:Arial; background:#f8fafc; padding:40px;">
        <div style="max-width:520px; margin:auto; background:white; padding:30px; border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,.08);">
          <h2>EXPO PHARMA Güvenli Ödeme</h2>
          <p><b>Sipariş No:</b> #${orderName}</p>
          <p><b>Tutar:</b> ${amount} TL</p>
          <p>Ödeme işlemi VakıfBank sanal POS altyapısı üzerinden tamamlanacaktır.</p>
          <form method="POST" action="/api/vakifbank-enrollment">
  <input type="hidden" name="orderId" value="${orderName}" />
  <input type="hidden" name="amount" value="${amount}" />

  <input name="cardNumber" placeholder="Kart Numarası" required style="width:100%; padding:12px; margin-bottom:10px;" />
  <input name="expiryDate" placeholder="AA/YY" required style="width:100%; padding:12px; margin-bottom:10px;" />
  <input name="cvv" placeholder="CVV" required style="width:100%; padding:12px; margin-bottom:10px;" />

  <button type="submit" style="width:100%; padding:14px; border:0; border-radius:10px; background:#16a34a; color:white; font-size:16px; font-weight:bold;">
    VakıfBank 3D Secure ile Öde
  </button>
</form>
        </div>
      </body>
    </html>
  `);
});
app.post("/api/vakifbank-enrollment", express.urlencoded({ extended: true }), async (req, res) => {
  const { orderId, amount, cardNumber, expiryDate, cvv } = req.body || {};

const merchantPaymentId = `ORDER_${orderId}_${Date.now()}`;

return res.send(`
<html>
<head>
<meta charset="UTF-8" />
<title>3D Secure Yönlendirme</title>
</head>
<body style="font-family:Arial;padding:40px;">
<h2>3D Secure yönlendiriliyor...</h2>

<form id="vakifForm" method="POST" action="https://entegrasyon.asseco-see.com.tr/fim/est3Dgate">

<input type="hidden" name="clientid" value="${VAKIFBANK_MERCHANT_ID}" />
<input type="hidden" name="storetype" value="3d_pay_hosting" />
<input type="hidden" name="amount" value="${amount}" />
<input type="hidden" name="oid" value="${merchantPaymentId}" />
<input type="hidden" name="okUrl" value="https://www.expo-pharma.com" />
<input type="hidden" name="failUrl" value="https://www.expo-pharma.com" />
<input type="hidden" name="lang" value="tr" />
<input type="hidden" name="rnd" value="${Date.now()}" />
<input type="hidden" name="currency" value="949" />
<input type="hidden" name="pan" value="${cardNumber}" />
<input type="hidden" name="Ecom_Payment_Card_ExpDate_Month" value="${expiryDate.split('/')[0]}" />
<input type="hidden" name="Ecom_Payment_Card_ExpDate_Year" value="20${expiryDate.split('/')[1]}" />
<input type="hidden" name="cv2" value="${cvv}" />

<button type="submit">
3D Secure ile Devam Et
</button>

</form>

<script>
document.getElementById('vakifForm').submit();
</script>

</body>
</html>
`);
  
});
app.post("/api/shopify-order-webhook", async (req, res) => {
  try {
    const order = req.body || {};

    console.log("SHOPIFY ORDER WEBHOOK GELDİ:", {
      orderId: order.id,
      orderName: order.name,
      email: order.email,
      phone: order.phone,
      totalPrice: order.total_price,
      currency: order.currency,
      paymentGatewayNames: order.payment_gateway_names,
      financialStatus: order.financial_status
    });

    
const paymentUrl = makeVakifbankPaymentUrl(order);

console.log("REDIRECT PAYMENT URL:", paymentUrl);
    return res.status(200).json({
  status: "ok",
  paymentUrl,
  orderId: order.id || null,
  orderName: order.name || null
});
  } catch (error) {
    console.error("SHOPIFY ORDER WEBHOOK ERROR:", error);

    return res.status(200).json({
      status: "error",
      message: "Webhook alındı ama işlenemedi"
    });
  }
});

/* -------------------------------
   ADMIN LOGIN
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
  return res.json({ status: "ok" });
});

/* -------------------------------
   ADMIN OKUMA ENDPOINTLERİ
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
              status
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

app.get("/api/admin-products-full", checkAdminPassword, async (req, res) => {
  try {
    let products = [];

    try {
      products = await fetchShopifyAdminProducts();
    } catch (adminError) {
      console.error("ADMIN SHOPIFY READ FAILED:", adminError);
      products = await fetchShopifyPublicProducts();
    }

    const costItems = await fetchCostSheet();

    const rows = products.map((product) => {
      const cost = matchCostData(product, costItems);
      const profit = cost ? calculateProfit(product, cost) : null;
      return productToOperationRow(product, cost, profit);
    });

    return res.json({
      status: "ok",
      count: rows.length,
      products: rows
    });
  } catch (error) {
    console.error("ADMIN PRODUCTS FULL ERROR:", error);
    return res.status(500).json({
      error: "Ürün listesi alınamadı."
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
    const { variantId, price, compareAtPrice, barcode, sku } = req.body || {};

    if (!variantId) {
      return res.status(400).json({ error: "variantId eksik." });
    }

    const numericVariantId = String(variantId).split("/").pop();

    if (!numericVariantId || Number.isNaN(Number(numericVariantId))) {
      return res.status(400).json({ error: "variantId formatı hatalı." });
    }

    const variant = {
      id: Number(numericVariantId)
    };

    if (price !== undefined && price !== null && price !== "") {
      variant.price = String(roundMoney(toNumber(price)));
    }

    if (compareAtPrice !== undefined && compareAtPrice !== null && compareAtPrice !== "") {
      variant.compare_at_price = String(roundMoney(toNumber(compareAtPrice)));
    }

    if (compareAtPrice === "") {
      variant.compare_at_price = null;
    }

    if (barcode !== undefined) {
      variant.barcode = String(barcode || "").trim();
    }

    if (sku !== undefined) {
      variant.sku = String(sku || "").trim();
    }

    const data = await shopifyRest(`/variants/${numericVariantId}.json`, {
      method: "PUT",
      body: JSON.stringify({ variant })
    });

    return res.json({
      status: "ok",
      variant: data.variant
    });
  } catch (error) {
    console.error("UPDATE VARIANT BASIC ERROR:", error);
    return res.status(500).json({
      error: error.message || "Shopify varyant güncellemesi başarısız."
    });
  }
});

app.post("/api/update-inventory-item", checkAdminPassword, async (req, res) => {
  try {
    const { inventoryItemId, tracked, cost } = req.body || {};

    if (!inventoryItemId) {
      return res.status(400).json({ error: "inventoryItemId eksik." });
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

app.post("/api/update-product-status", checkAdminPassword, async (req, res) => {
  try {
    const { productId, status } = req.body || {};

    if (!productId) {
      return res.status(400).json({ error: "productId eksik." });
    }

    const cleanStatus = String(status || "").toUpperCase();
    const allowedStatuses = ["ACTIVE", "DRAFT", "ARCHIVED"];

    if (!allowedStatuses.includes(cleanStatus)) {
      return res.status(400).json({
        error: "status ACTIVE, DRAFT veya ARCHIVED olmalı."
      });
    }

    const data = await shopifyGraphQL(
      `
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            title
            status
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      {
        input: {
          id: productId,
          status: cleanStatus
        }
      }
    );

    const errors = data.productUpdate.userErrors || [];

    if (errors.length) {
      return res.status(400).json({
        error: errors.map((e) => e.message).join(", ")
      });
    }

    return res.json({
      status: "ok",
      product: data.productUpdate.product
    });
  } catch (error) {
    console.error("UPDATE PRODUCT STATUS ERROR:", error);
    return res.status(500).json({
      error: error.message || "Ürün durumu güncellenemedi."
    });
  }
});

app.post("/api/bulk-product-action", checkAdminPassword, async (req, res) => {
  try {
    const {
      items,
      action,
      price,
      compareAtPrice,
      cost,
      status,
      discountPercent
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Seçili ürün yok." });
    }

    const results = [];

    for (const item of items) {
      try {
        if (action === "set_status") {
          if (!item.productId) throw new Error("productId eksik.");

          const cleanStatus = String(status || "ACTIVE").toUpperCase();

          const data = await shopifyGraphQL(
            `
            mutation productUpdate($input: ProductInput!) {
              productUpdate(input: $input) {
                product {
                  id
                  status
                }
                userErrors {
                  message
                }
              }
            }
            `,
            {
              input: {
                id: item.productId,
                status: cleanStatus
              }
            }
          );

          const errors = data.productUpdate.userErrors || [];
          if (errors.length) throw new Error(errors.map((e) => e.message).join(", "));

          results.push({
            ok: true,
            productId: item.productId,
            action,
            status: cleanStatus
          });
        }

        if (action === "set_variant_price") {
          if (!item.variantId) throw new Error("variantId eksik.");

          const numericVariantId = String(item.variantId).split("/").pop();

          const variant = {
            id: Number(numericVariantId)
          };

          if (price !== undefined && price !== "") {
            variant.price = String(roundMoney(toNumber(price)));
          }

          if (compareAtPrice !== undefined && compareAtPrice !== "") {
            variant.compare_at_price = String(roundMoney(toNumber(compareAtPrice)));
          }

          await shopifyRest(`/variants/${numericVariantId}.json`, {
            method: "PUT",
            body: JSON.stringify({ variant })
          });

          results.push({
            ok: true,
            variantId: item.variantId,
            action
          });
        }

        if (action === "discount_from_psf") {
          if (!item.variantId) throw new Error("variantId eksik.");
          if (!item.psf || Number(item.psf) <= 0) throw new Error("PSF yok.");

          const numericVariantId = String(item.variantId).split("/").pop();
          const percent = toNumber(discountPercent || 0);

          const newPrice = roundMoney(Number(item.psf) * (1 - percent / 100));

          const variant = {
            id: Number(numericVariantId),
            price: String(newPrice),
            compare_at_price: String(roundMoney(Number(item.psf)))
          };

          await shopifyRest(`/variants/${numericVariantId}.json`, {
            method: "PUT",
            body: JSON.stringify({ variant })
          });

          results.push({
            ok: true,
            variantId: item.variantId,
            psf: item.psf,
            newPrice,
            action
          });
        }

        if (action === "set_cost") {
          if (!item.inventoryItemId) throw new Error("inventoryItemId eksik.");

          const data = await shopifyGraphQL(
            `
            mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                inventoryItem {
                  id
                  unitCost {
                    amount
                    currencyCode
                  }
                }
                userErrors {
                  message
                }
              }
            }
            `,
            {
              id: item.inventoryItemId,
              input: {
                cost: String(roundMoney(toNumber(cost)))
              }
            }
          );

          const errors = data.inventoryItemUpdate.userErrors || [];
          if (errors.length) throw new Error(errors.map((e) => e.message).join(", "));

          results.push({
            ok: true,
            inventoryItemId: item.inventoryItemId,
            action
          });
        }
      } catch (itemError) {
        results.push({
          ok: false,
          item,
          error: itemError.message
        });
      }
    }

    return res.json({
      status: "ok",
      total: items.length,
      success: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results
    });
  } catch (error) {
    console.error("BULK PRODUCT ACTION ERROR:", error);
    return res.status(500).json({
      error: error.message || "Toplu işlem başarısız."
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
Kullanıcının ihtiyacını anlamak için doğal, kısa ve hedefli sorular sormak.

Kurallar:
- Tanı koyma.
- Tedavi iddiası yazma.
- Ürün satmaya acele etme.
- Bot gibi form soruları sorma.
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
  "intro": "Kısa, doğal ve güven veren bir cümle",
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
        model: CLAVIS_MODEL,
        input: triagePrompt
      });

      const parsed = safeJsonParse(response.output_text);

      if (!parsed || !Array.isArray(parsed.questions)) {
        return res.json({
          intro:
            "Daha doğru yönlendirme yapabilmem için birkaç kısa bilgiyi netleştirelim.",
          questions: [
            "Şikâyetiniz ne kadar süredir var?",
            "Hangi bölgede daha yoğun?",
            "Sivilceler iltihaplı mı, yoksa daha çok siyah nokta/kapalı komedon şeklinde mi?",
            "Cildiniz ürünlerden sonra kolay kızarır veya yanma yapar mı?"
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
      const matchResult = await matchProductsFromShopify(answerText);
      const adviceStrategy = matchResult.strategy;
      const matchedProducts = matchResult.products;

      const productText =
        matchedProducts.length > 0
          ? matchedProducts
              .map(
                (p) =>
                  `- ${p.title} | Rol: ${p.clavisRole || "Ürün önerisi"} | Neden: ${p.clavisReason || ""} | Fiyat: ${p.price} TL | Link: ${p.url} | Kategori: ${p.product_type || "Belirtilmemiş"}`
              )
              .join("\n")
          : "Uygun ürün eşleşmesi bulunamadı.";

      const content = [
        {
          type: "input_text",
          text: `
Sen Expo Pharma'nın CLAVIS AI eczacı destek asistanısın.

Görevin:
Kullanıcının verdiği cevaplara göre doğal, profesyonel ve eczacı mantığıyla ürün danışmanlığı yapmak.

Çok önemli kurallar:
- Tanı koyma.
- "Tedavi eder", "kesin geçirir", "hastalığı iyileştirir" gibi kesin ifadeler kullanma.
- "Uygun olabilir", "destekleyebilir", "değerlendirilebilir" gibi güvenli dil kullan.
- Bot gibi yazma.
- Mekanik listeleme yapma.
- Ürünleri bakım rutini/öncelik mantığıyla açıkla.
- Ürün uygun değilse önermemeyi bil.
- Kırmızı bayrak varsa doktora/dermatoloğa yönlendir.
- Ürün önerirken sadece aşağıdaki seçilen ürün havuzundan öner.
- En fazla 4 ürün öner.
- Cevap Türkçe olsun.
- Kısa ama güven veren profesyonel tonda yaz.

Kullanıcı cevapları:
${answerText}

Clavis ürün stratejisi:
${JSON.stringify(adviceStrategy, null, 2)}

Siteden seçilen ürünler:
${productText}

Cevabı şu başlıklarla yaz:

1. Kısa Değerlendirme
2. Sizin İçin Netleştirdiğim Noktalar
3. Ürün Seçim Mantığı
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
        model: CLAVIS_MODEL,
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
          role: p.clavisRole || "Ürün önerisi",
          reason: p.clavisReason || "Verdiğiniz bilgilere göre bu ürün değerlendirilebilir."
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
