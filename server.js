import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";
import { chromium } from "playwright";

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
   BEK DEPO TARAYICI OTOMASYONU
   İlk sürüm: tek barkod ve küçük toplu kontrol (salt okunur)
-------------------------------- */

const BEK_BASE_URL = process.env.BEK_BASE_URL || "https://esube.bek.org.tr/irj/portal/";
const BEK_USERNAME = process.env.BEK_USERNAME;
const BEK_PASSWORD = process.env.BEK_PASSWORD;
const ISKOOP_BASE_URL = process.env.ISKOOP_BASE_URL || "https://esube.iskoop.org/irj/portal/";
const ISKOOP_USERNAME = process.env.ISKOOP_USERNAME;
const ISKOOP_PASSWORD = process.env.ISKOOP_PASSWORD;
const ALLIANCE_BASE_URL = process.env.ALLIANCE_BASE_URL || "https://esiparisv2.alliance-healthcare.com.tr/";
const ALLIANCE_PHARMACY_CODE = process.env.ALLIANCE_PHARMACY_CODE;
const ALLIANCE_USERNAME = process.env.ALLIANCE_USERNAME;
const ALLIANCE_PASSWORD = process.env.ALLIANCE_PASSWORD;
const SANCAK_BASE_URL = process.env.SANCAK_BASE_URL || "https://eticaret.sancakecza.com.tr/";
const SANCAK_USERNAME = process.env.SANCAK_USERNAME;
const SANCAK_PASSWORD = process.env.SANCAK_PASSWORD;
const TEBRP_BASE_URL = String(process.env.TEBRP_BASE_URL || "https://www.tebrp.com/tebrp_plus/").replace(/\/+$/, "") + "/";
const TEBRP_LOGIN_URL = process.env.TEBRP_LOGIN_URL || `${TEBRP_BASE_URL}login/login.jsp?from=%2Ftebrp_plus%2Fuygulama%3Foperation%3Dalt_giris`;
const TEBRP_SEARCH_URL = process.env.TEBRP_SEARCH_URL || `${TEBRP_BASE_URL}uygulama?operation=alt_giris`;
const TEBRP_USERNAME = process.env.TEBRP_USERNAME;
const TEBRP_PASSWORD = process.env.TEBRP_PASSWORD;
const TEBRP_CONNECTOR_TOKEN = String(process.env.TEBRP_CONNECTOR_TOKEN || "").trim();
const TEBRP_CONNECTOR_ONLINE_MS = Number(process.env.TEBRP_CONNECTOR_ONLINE_MS || 180000);
const TEBRP_CONNECTOR_JOB_TIMEOUT_MS = Number(process.env.TEBRP_CONNECTOR_JOB_TIMEOUT_MS || 120000);


/* -------------------------------
   KALICI TARAYICI VE DEPO OTURUM HAVUZU
   Render yeniden başlamadığı sürece oturumları ve sekmeleri açık tutar.
-------------------------------- */

let depotBrowserPromise = null;
const depotSessions = new Map();
const depotLocks = new Map();
const depotResultCache = new Map();
const DEPOT_CACHE_TTL_MS = 5 * 60 * 1000;

async function getDepotBrowser() {
  if (!depotBrowserPromise) {
    depotBrowserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-renderer-backgrounding"
      ]
    }).catch((error) => {
      depotBrowserPromise = null;
      throw error;
    });
  }
  return depotBrowserPromise;
}

async function closeDepotSession(key) {
  const session = depotSessions.get(key);
  depotSessions.delete(key);
  if (session) {
    await session.context?.close().catch(() => {});
  }
}

async function getDepotSession(key, loginFn) {
  let session = depotSessions.get(key);
  if (session && !session.page.isClosed()) return session;

  const browser = await getDepotBrowser();
  const context = await browser.newContext({
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    viewport: { width: 1440, height: 1000 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  await loginFn(page);
  session = { context, page, createdAt: Date.now(), lastUsedAt: Date.now() };
  depotSessions.set(key, session);
  return session;
}

async function withDepotLock(key, task) {
  const previous = depotLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  depotLocks.set(key, previous.then(() => current));
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (depotLocks.get(key) === current) depotLocks.delete(key);
  }
}

function getCachedDepotResult(key, barcode) {
  const item = depotResultCache.get(`${key}:${barcode}`);
  if (!item || Date.now() - item.savedAt > DEPOT_CACHE_TTL_MS) return null;
  return { ...item.result, cached: true };
}

function setCachedDepotResult(key, barcode, result) {
  depotResultCache.set(`${key}:${barcode}`, { savedAt: Date.now(), result });
}

async function runPersistentDepotCheck({ key, barcode, loginFn, findSearchInput, executeSearch, readProduct }) {
  const cleanBarcode = String(barcode || "").replace(/\D/g, "");
  if (cleanBarcode.length < 8 || cleanBarcode.length > 14) {
    throw new Error("Geçerli bir barkod girin (8-14 rakam).");
  }

  const cached = getCachedDepotResult(key, cleanBarcode);
  if (cached) return cached;

  return withDepotLock(key, async () => {
    const cachedAfterWait = getCachedDepotResult(key, cleanBarcode);
    if (cachedAfterWait) return cachedAfterWait;

    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const session = await getDepotSession(key, loginFn);
        session.lastUsedAt = Date.now();
        let input;
        try {
          input = await findSearchInput(session.page);
        } catch {
          await closeDepotSession(key);
          const fresh = await getDepotSession(key, loginFn);
          input = await findSearchInput(fresh.page);
          session.page = fresh.page;
        }
        await executeSearch(session.page, input, cleanBarcode);
        const result = await readProduct(session.page, cleanBarcode);

        const returnedBarcode = String(
          result?.verifiedBarcode ||
          result?.barcode ||
          result?.requestedBarcode ||
          ""
        ).replace(/\D/g, "");

        if (returnedBarcode !== cleanBarcode) {
          throw new Error(
            `${key.toUpperCase()} eski veya farklı ürün sonucu döndürdü. Aranan: ${cleanBarcode}, okunan: ${returnedBarcode || "yok"}`
          );
        }

        setCachedDepotResult(key, cleanBarcode, result);
        return result;
      } catch (error) {
        lastError = error;
        await closeDepotSession(key);
      }
    }
    throw lastError || new Error("Depo kontrolü tamamlanamadı.");
  });
}

function parseTurkishMoney(value) {
  let text = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[^0-9,.-]/g, "")
    .trim();

  if (!text) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) text = text.replace(/\./g, "").replace(",", ".");
    else text = text.replace(/,/g, "");
  } else if (lastComma > -1) {
    text = text.replace(",", ".");
  }

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

async function findBekSearchInput(page) {
  const selectors = [
    'input[placeholder*="Kelime"]',
    'input[placeholder*="Barkod"]',
    'input[aria-label*="Kelime"]',
    'input[aria-label*="Barkod"]'
  ];

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      if (await locator.count()) {
        try {
          if (await locator.isVisible()) return locator;
        } catch {}
      }
    }
  }

  // Son çare: giriş alanları dışındaki görünür metin kutusu.
  for (const frame of page.frames()) {
    const inputs = frame.locator('input[type="text"]:not(#logonuidfield)');
    const count = await inputs.count();
    for (let i = 0; i < count; i += 1) {
      const locator = inputs.nth(i);
      try {
        if (await locator.isVisible()) return locator;
      } catch {}
    }
  }

  throw new Error("BEK ürün arama kutusu bulunamadı.");
}

async function loginBek(page) {
  if (!BEK_USERNAME || !BEK_PASSWORD) {
    throw new Error("BEK_USERNAME ve BEK_PASSWORD Render Environment içinde tanımlı değil.");
  }

  await page.goto(BEK_BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  const username = page.locator("#logonuidfield");
  const password = page.locator("#logonpassfield");

  if (await username.count()) {
    await username.fill(String(BEK_USERNAME));
    await password.fill(String(BEK_PASSWORD));
    await page.locator('input[name="login"]').click();
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  }

  // Portal içeriğinin ve arama kutusunun hazır olmasını bekle.
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 60000) {
    try {
      return await findBekSearchInput(page);
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1200);
    }
  }

  throw lastError || new Error("BEK girişinden sonra ürün arama ekranı açılmadı.");
}

function pickBekProductName(lines, barcode) {
  const barcodeIndex = lines.findIndex((line) => line.replace(/\D/g, "") === barcode);
  if (barcodeIndex > 0) {
    for (let i = barcodeIndex - 1; i >= Math.max(0, barcodeIndex - 6); i -= 1) {
      const candidate = lines[i].trim();
      if (
        candidate.length >= 8 &&
        !/^(PSF|DSF|Net Fiyat|Ürün Özellikleri|Satış Detayı|Stokta|Menü)$/i.test(candidate) &&
        !/^₺/.test(candidate)
      ) {
        return candidate;
      }
    }
  }
  return "";
}

async function readBekProduct(page, requestedBarcode) {
  // Arama kutusundaki barkod ana sayfada da göründüğü için sadece barkoda bakarak
  // frame seçmek yanlış sonuç verebilir. Ürün detayını; barkod + fiyat/stok alanlarıyla
  // birlikte puanlayarak buluyoruz.
  const deadline = Date.now() + 60000;
  let best = null;

  while (Date.now() < deadline) {
    const candidates = [];

    for (const frame of page.frames()) {
      try {
        const text = await frame.locator("body").innerText({ timeout: 3500 });
        const normalized = String(text || "").replace(/\s+/g, " ").trim();
        const digitsOnly = normalized.replace(/\D/g, "");

        const hasBarcode = digitsOnly.includes(requestedBarcode);
        const exactBarcodeLine = String(text || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .some((line) => (line.match(/\d{8,14}/g) || []).includes(requestedBarcode));
        const hasPsf = /\bPSF\b/i.test(normalized);
        const hasDsf = /\bDSF\b/i.test(normalized);
        const hasNet = /Net\s*Fiyat/i.test(normalized);
        const hasStock = /YETERL[Iİ]\s+stok|malzeme sat[ıi]lamaz|Stokta\s*Yok|Stok\s*Yok|\bStokta\b/i.test(normalized);
        const hasProductDetail = /Ürün\s*Özellikleri|Satış\s*Detayı|Siparişe?\s*1\s*Ekle/i.test(normalized);

        let score = 0;
        if (hasBarcode) score += 5;
        if (hasPsf) score += 4;
        if (hasDsf) score += 2;
        if (hasNet) score += 3;
        if (hasStock) score += 3;
        if (hasProductDetail) score += 4;

        candidates.push({ frame, text, normalized, score, hasBarcode, exactBarcodeLine, hasPsf, hasStock, hasProductDetail });
      } catch {}
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates[0] && (!best || candidates[0].score > best.score)) best = candidates[0];

    // Ürün detay sayfası için barkodun yanında en az PSF veya stok ve detay işareti olmalı.
    const exact = candidates.find((c) =>
      c.exactBarcodeLine && c.hasProductDetail && (c.hasPsf || c.hasStock)
    );

    if (exact) {
      best = exact;
      break;
    }

    await page.waitForTimeout(1200);
  }

  if (!best || best.score < 8 || !best.exactBarcodeLine) {
    console.error("BEK DEBUG - pages:", contextPageDebug(page));
    console.error("BEK DEBUG - best candidate:", best ? {
      url: best.frame.url(), score: best.score, preview: best.normalized.slice(0, 1800)
    } : null);
    throw new Error("BEK ürün detay sayfası yüklenemedi. Giriş veya barkod araması tamamlanmamış olabilir.");
  }

  const matchedFrame = best.frame;
  const bodyText = best.text;
  const normalizedBody = best.normalized;
  const lines = bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const moneyPattern = "(?:₺|TL)?\\s*([\\d.]+,\\d{2})";
  const psfMatch = normalizedBody.match(new RegExp("\\bPSF\\b[\\s\\S]{0,100}?" + moneyPattern, "i"));
  const dsfMatch = normalizedBody.match(new RegExp("\\bDSF\\b[\\s\\S]{0,100}?" + moneyPattern, "i"));
  const netMatch = normalizedBody.match(new RegExp("Net\\s*Fiyat[\\s\\S]{0,100}?" + moneyPattern, "i"));
  const limitMatch = normalizedBody.match(/Kalan\s+limitiniz\s*:\s*(\d+)/i);

  const unavailable = /YETERL[Iİ]\s+stok\s+bulunamad[ıi]|malzeme\s+sat[ıi]lamaz|Stokta\s*Yok|Stok\s*Yok/i.test(normalizedBody);
  const available = !unavailable && /\bStokta\b/i.test(normalizedBody);

  const exactBarcodeLineIndex = lines.findIndex((line) => line.replace(/\D/g, "") === requestedBarcode);
  let productName = "";

  if (exactBarcodeLineIndex > 0) {
    for (let i = exactBarcodeLineIndex - 1; i >= Math.max(0, exactBarcodeLineIndex - 8); i -= 1) {
      const candidate = lines[i].trim();
      if (
        candidate.length >= 8 &&
        !/^(PSF|DSF|Net Fiyat|Fiyat Tarihçesi|Ürün Özellikleri|Satış Detayı|Stokta|Menü|Hepsi|İlaç|İlaç Dışı)$/i.test(candidate) &&
        !/Daha Sonrası İçin Kaydedilenler/i.test(candidate) &&
        !/Kelime, Barkod|arama yapabilmek/i.test(candidate) &&
        !/^₺/.test(candidate) &&
        !/^\d+$/.test(candidate)
      ) {
        productName = candidate;
        break;
      }
    }
  }

  // Barkodun hemen üstünden ad bulunamazsa büyük harfli ve ürün benzeri satırı seç.
  if (!productName) {
    productName = lines.find((line) =>
      line.length >= 10 &&
      /[A-ZÇĞİÖŞÜ]/.test(line) &&
      !/^(PSF|DSF|NET FİYAT|FİYAT TARİHÇESİ|ÜRÜN ÖZELLİKLERİ|SATIŞ DETAYI|STOKTA|DAHA SONRASI)/i.test(line) &&
      !/Kelime, Barkod|arama yapabilmek|Hesaplar ve Raporlar/i.test(line)
    ) || "";
  }

  if (!productName && !psfMatch && !unavailable && !available) {
    console.error("BEK DEBUG - selected frame URL:", matchedFrame.url());
    console.error("BEK DEBUG - selected score:", best.score);
    console.error("BEK DEBUG - body preview:", normalizedBody.slice(0, 2200));
    throw new Error("BEK ürün detay bilgileri okunamadı. Detay ekranı açıldı fakat alanlar çözümlenemedi.");
  }

  return {
    depot: "BEK",
    requestedBarcode,
    barcode: requestedBarcode,
    verifiedBarcode: requestedBarcode,
    productName,
    psf: psfMatch ? parseTurkishMoney(psfMatch[1]) : null,
    dsf: dsfMatch ? parseTurkishMoney(dsfMatch[1]) : null,
    netPrice: netMatch ? parseTurkishMoney(netMatch[1]) : null,
    inStock: available ? true : unavailable ? false : null,
    stockText: available ? "Stokta" : unavailable ? "Stokta yok / satılamaz" : "Belirsiz",
    remainingLimit: limitMatch ? Number(limitMatch[1]) : null,
    checkedAt: new Date().toISOString(),
    url: matchedFrame.url() || page.url()
  };
}

function contextPageDebug(page) {
  return page.frames().map((frame) => frame.url()).join(" | ");
}

async function checkBekBarcode(barcode) {
  return runPersistentDepotCheck({
    key: "bek",
    barcode,
    loginFn: loginBek,
    findSearchInput: findBekSearchInput,
    executeSearch: async (page, input, cleanBarcode) => {
      // Her barkodda portalı temiz arama ekranına döndür. Böylece önceki
      // ürünün adı, fiyatı ve stok durumu yeni ürüne taşınamaz.
      await page.goto(BEK_BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      const freshInput = await findBekSearchInput(page);
      await freshInput.fill("");
      await freshInput.fill(cleanBarcode);
      await freshInput.press("Enter");
    },
    readProduct: readBekProduct
  });
}


/* -------------------------------
   İSKOOP DEPO TARAYICI OTOMASYONU
   BEK ile aynı portal altyapısını kullanır. Salt okunur.
-------------------------------- */

async function findIskoopSearchInput(page) {
  const selectors = [
    'input[placeholder*="Kelime"]',
    'input[placeholder*="Barkod"]',
    'input[aria-label*="Kelime"]',
    'input[aria-label*="Barkod"]'
  ];

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      if (await locator.count()) {
        try {
          if (await locator.isVisible()) return locator;
        } catch {}
      }
    }
  }

  // Son çare: giriş alanları dışındaki görünür metin kutusu.
  for (const frame of page.frames()) {
    const inputs = frame.locator('input[type="text"]:not(#logonuidfield)');
    const count = await inputs.count();
    for (let i = 0; i < count; i += 1) {
      const locator = inputs.nth(i);
      try {
        if (await locator.isVisible()) return locator;
      } catch {}
    }
  }

  throw new Error("İSKOOP ürün arama kutusu bulunamadı.");
}

async function loginIskoop(page) {
  if (!ISKOOP_USERNAME || !ISKOOP_PASSWORD) {
    throw new Error("ISKOOP_USERNAME ve ISKOOP_PASSWORD Render Environment içinde tanımlı değil.");
  }

  await page.goto(ISKOOP_BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  const username = page.locator("#logonuidfield");
  const password = page.locator("#logonpassfield");

  if (await username.count()) {
    await username.fill(String(ISKOOP_USERNAME));
    await password.fill(String(ISKOOP_PASSWORD));
    await page.locator('input[name="login"]').click();
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  }

  // Portal içeriğinin ve arama kutusunun hazır olmasını iskoople.
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 60000) {
    try {
      return await findIskoopSearchInput(page);
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1200);
    }
  }

  throw lastError || new Error("İSKOOP girişinden sonra ürün arama ekranı açılmadı.");
}

async function readIskoopProduct(page, requestedBarcode) {
  // Arama kutusundaki barkod ana sayfada da göründüğü için sadece barkoda bakarak
  // frame seçmek yanlış sonuç verebilir. Ürün detayını; barkod + fiyat/stok alanlarıyla
  // birlikte puanlayarak buluyoruz.
  const deadline = Date.now() + 60000;
  let best = null;

  while (Date.now() < deadline) {
    const candidates = [];

    for (const frame of page.frames()) {
      try {
        const text = await frame.locator("body").innerText({ timeout: 3500 });
        const normalized = String(text || "").replace(/\s+/g, " ").trim();
        const digitsOnly = normalized.replace(/\D/g, "");

        const hasBarcode = digitsOnly.includes(requestedBarcode);
        const exactBarcodeLine = String(text || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .some((line) => (line.match(/\d{8,14}/g) || []).includes(requestedBarcode));
        const hasPsf = /\b(?:PSF|TVS)\b/i.test(normalized);
        const hasDsf = /\bDSF\b/i.test(normalized);
        const hasNet = /Net\s*Fiyat/i.test(normalized);
        const hasStock = /YETERL[Iİ]\s+stok|malzeme sat[ıi]lamaz|Stokta\s*Yok|Stok\s*Yok|\bStokta\b/i.test(normalized);
        const hasProductDetail = /Ürün\s*Özellikleri|Satış\s*Detayı|Siparişe?\s*1\s*Ekle/i.test(normalized);

        let score = 0;
        if (hasBarcode) score += 5;
        if (hasPsf) score += 4;
        if (hasDsf) score += 2;
        if (hasNet) score += 3;
        if (hasStock) score += 3;
        if (hasProductDetail) score += 4;

        candidates.push({ frame, text, normalized, score, hasBarcode, exactBarcodeLine, hasPsf, hasStock, hasProductDetail });
      } catch {}
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates[0] && (!best || candidates[0].score > best.score)) best = candidates[0];

    // Ürün detay sayfası için barkodun yanında en az PSF veya stok ve detay işareti olmalı.
    const exact = candidates.find((c) =>
      c.exactBarcodeLine && c.hasProductDetail && (c.hasPsf || c.hasStock)
    );

    if (exact) {
      best = exact;
      break;
    }

    await page.waitForTimeout(1200);
  }

  if (!best || best.score < 8 || !best.exactBarcodeLine) {
    console.error("İSKOOP DEBUG - pages:", contextPageDebug(page));
    console.error("İSKOOP DEBUG - best candidate:", best ? {
      url: best.frame.url(), score: best.score, preview: best.normalized.slice(0, 1800)
    } : null);
    throw new Error("İSKOOP ürün detay sayfası yüklenemedi. Giriş veya barkod araması tamamlanmamış olabilir.");
  }

  const matchedFrame = best.frame;
  const bodyText = best.text;
  const normalizedBody = best.normalized;
  const lines = bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const moneyPattern = "(?:₺|TL)?\\s*([\\d.]+,\\d{2})";
  const psfMatch = normalizedBody.match(new RegExp("\\b(?:PSF|TVS)\\b[\\s\\S]{0,100}?" + moneyPattern, "i"));
  const dsfMatch = normalizedBody.match(new RegExp("\\bDSF\\b[\\s\\S]{0,100}?" + moneyPattern, "i"));
  const netMatch = normalizedBody.match(new RegExp("Net\\s*Fiyat[\\s\\S]{0,100}?" + moneyPattern, "i"));
  const limitMatch = normalizedBody.match(/Kalan\s+limitiniz\s*:\s*(\d+)/i);

  const unavailable = /YETERL[Iİ]\s+stok\s+bulunamad[ıi]|malzeme\s+sat[ıi]lamaz|Stokta\s*Yok|Stok\s*Yok/i.test(normalizedBody);
  const available = !unavailable && /\bStokta\b/i.test(normalizedBody);

  const exactBarcodeLineIndex = lines.findIndex((line) => line.replace(/\D/g, "") === requestedBarcode);
  let productName = "";

  if (exactBarcodeLineIndex > 0) {
    for (let i = exactBarcodeLineIndex - 1; i >= Math.max(0, exactBarcodeLineIndex - 8); i -= 1) {
      const candidate = lines[i].trim();
      if (
        candidate.length >= 8 &&
        !/^(PSF|TVS|DSF|Net Fiyat|Fiyat Tarihçesi|Ürün Özellikleri|Satış Detayı|Stokta|Menü|Hepsi|İlaç|İlaç Dışı)$/i.test(candidate) &&
        !/Daha Sonrası İçin Kaydedilenler/i.test(candidate) &&
        !/Kelime, Barkod|arama yapabilmek/i.test(candidate) &&
        !/^₺/.test(candidate) &&
        !/^\d+$/.test(candidate)
      ) {
        productName = candidate;
        break;
      }
    }
  }

  // Barkodun hemen üstünden ad bulunamazsa büyük harfli ve ürün benzeri satırı seç.
  if (!productName) {
    productName = lines.find((line) =>
      line.length >= 10 &&
      /[A-ZÇĞİÖŞÜ]/.test(line) &&
      !/^(PSF|TVS|DSF|NET FİYAT|FİYAT TARİHÇESİ|ÜRÜN ÖZELLİKLERİ|SATIŞ DETAYI|STOKTA|DAHA SONRASI)/i.test(line) &&
      !/Kelime, Barkod|arama yapabilmek|Hesaplar ve Raporlar/i.test(line)
    ) || "";
  }

  if (!productName && !psfMatch && !unavailable && !available) {
    console.error("İSKOOP DEBUG - selected frame URL:", matchedFrame.url());
    console.error("İSKOOP DEBUG - selected score:", best.score);
    console.error("İSKOOP DEBUG - body preview:", normalizedBody.slice(0, 2200));
    throw new Error("İSKOOP ürün detay bilgileri okunamadı. Detay ekranı açıldı fakat alanlar çözümlenemedi.");
  }

  return {
    depot: "İSKOOP",
    requestedBarcode,
    barcode: requestedBarcode,
    verifiedBarcode: requestedBarcode,
    productName,
    psf: psfMatch ? parseTurkishMoney(psfMatch[1]) : null,
    dsf: dsfMatch ? parseTurkishMoney(dsfMatch[1]) : null,
    netPrice: netMatch ? parseTurkishMoney(netMatch[1]) : null,
    inStock: available ? true : unavailable ? false : null,
    stockText: available ? "Stokta" : unavailable ? "Stokta yok / satılamaz" : "Belirsiz",
    remainingLimit: limitMatch ? Number(limitMatch[1]) : null,
    checkedAt: new Date().toISOString(),
    url: matchedFrame.url() || page.url()
  };
}

async function checkIskoopBarcode(barcode) {
  return runPersistentDepotCheck({
    key: "iskoop",
    barcode,
    loginFn: loginIskoop,
    findSearchInput: findIskoopSearchInput,
    executeSearch: async (page, input, cleanBarcode) => {
      // Her barkodda portalı temiz arama ekranına döndür. Böylece önceki
      // ürünün adı, fiyatı ve stok durumu yeni ürüne taşınamaz.
      await page.goto(ISKOOP_BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      const freshInput = await findIskoopSearchInput(page);
      await freshInput.fill("");
      await freshInput.fill(cleanBarcode);
      await freshInput.press("Enter");
    },
    readProduct: readIskoopProduct
  });
}



/* -------------------------------
   CENCORA ALLIANCE HEALTHCARE DEPO TARAYICI OTOMASYONU
   Salt okunur: barkod, ürün adı, depo fiyatı, net fiyat ve stok durumu.
-------------------------------- */

async function findAllianceSearchInput(page) {
  const selectors = [
    "#searchArea",
    'input[name="search"]',
    'input[placeholder*="En az 3 karakter"]',
    "#searchText"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible()) return locator;
      } catch {}
    }
  }

  throw new Error("Alliance ürün arama kutusu bulunamadı.");
}

async function loginAlliance(page) {
  if (!ALLIANCE_PHARMACY_CODE || !ALLIANCE_USERNAME || !ALLIANCE_PASSWORD) {
    throw new Error(
      "ALLIANCE_PHARMACY_CODE, ALLIANCE_USERNAME ve ALLIANCE_PASSWORD Render Environment içinde tanımlı değil."
    );
  }

  await page.goto(ALLIANCE_BASE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const pharmacyCode = page.locator("#pharmacyCode").first();
  if (await pharmacyCode.count()) {
    const usernameInput = page.locator("#Customer_username").first();
    const passwordInput = page.locator("#Customer_password").first();

    // Alliance giriş ekranı bazı oturumlarda kullanıcı adı/şifre alanlarını
    // dinamik olarak readonly yapabiliyor. Önce alanları etkinleştiriyoruz.
    for (const locator of [pharmacyCode, usernameInput, passwordInput]) {
      await locator.waitFor({ state: "visible", timeout: 30000 });
      await locator.evaluate((element) => {
        element.removeAttribute("readonly");
        element.removeAttribute("disabled");
        element.style.pointerEvents = "auto";
      });
    }

    await pharmacyCode.click();
    await pharmacyCode.fill(String(ALLIANCE_PHARMACY_CODE), { force: true });
    await pharmacyCode.press("Tab").catch(() => {});
    await page.waitForTimeout(500);

    // Eczane kodu doğrulamasından sonra readonly yeniden eklenirse tekrar kaldır.
    for (const locator of [usernameInput, passwordInput]) {
      await locator.evaluate((element) => {
        element.removeAttribute("readonly");
        element.removeAttribute("disabled");
      });
    }

    await usernameInput.fill(String(ALLIANCE_USERNAME), { force: true });
    await passwordInput.fill(String(ALLIANCE_PASSWORD), { force: true });

    const loginButton = page.locator("button.Customer_login__button").first();
    await loginButton.click({ force: true });

    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  }

  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < 60000) {
    try {
      return await findAllianceSearchInput(page);
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1200);
    }
  }

  const loginError = await page.locator(".validation-summary-errors, .alert-danger, #alert-panel")
    .innerText({ timeout: 1500 })
    .catch(() => "");

  throw new Error(
    loginError?.trim() ||
    lastError?.message ||
    "Alliance girişinden sonra ürün arama ekranı açılmadı."
  );
}

async function readAllianceProduct(page, requestedBarcode) {
  const deadline = Date.now() + 60000;
  let bodyText = "";

  while (Date.now() < deadline) {
    bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const compact = String(bodyText || "").replace(/\s+/g, " ").trim();
    const digits = compact.replace(/\D/g, "");

    const hasBarcode = digits.includes(requestedBarcode);
    const hasProduct = /AH\s*Ürün\s*Kodu|Ürün\s*Orjinal\s*Adı|Vergi\s*Hariç\s*Depocu\s*Satış\s*Fiyatı/i.test(compact);
    const hasStock = /Stok\s*Durumu|Ürün\s*Stokta\s*Var|Ürün\s*Stokta\s*Yok|\bVar\b|\bYok\b/i.test(compact);

    if (hasBarcode && (hasProduct || hasStock)) break;
    await page.waitForTimeout(1000);
  }

  const compact = String(bodyText || "").replace(/\s+/g, " ").trim();
  if (!compact.replace(/\D/g, "").includes(requestedBarcode)) {
    console.error("ALLIANCE DEBUG URL:", page.url());
    console.error("ALLIANCE DEBUG BODY:", compact.slice(0, 2500));
    throw new Error("Alliance ürün bulunamadı veya ürün sayfası açılamadı.");
  }

  let productName = "";

  productName = await page.locator("li.itembread a").last().innerText({ timeout: 2500 }).catch(() => "");
  productName = String(productName || "").replace(new RegExp("^" + requestedBarcode + "\\s*-\\s*"), "").trim();

  if (!productName) {
    const originalNameText = compact.match(/Ürün\s*Orjinal\s*Adı\s+(.+?)(?:Tedarikçi\s*Firma|Saklama\s*Koşulu|Ürün\s*Sınıfı)/i);
    productName = originalNameText?.[1]?.trim() || "";
  }

  if (!productName) {
    const breadcrumbMatch = compact.match(new RegExp(requestedBarcode + "\\s*-\\s*(.{5,150}?)(?:AH\\s*Ürün\\s*Kodu|Ürün\\s*Orjinal\\s*Adı)", "i"));
    productName = breadcrumbMatch?.[1]?.trim() || "";
  }

  // Alliance fiyat alanları birbirinden ayrıdır.
  let psf = null;
  const psfMatch = compact.match(/Tavsiye\s*Edilen\s*Perakende\s*Satış\s*Fiyatı\s*([\d.]+,\d{2})/i);
  psf = psfMatch ? parseTurkishMoney(psfMatch[1]) : null;

  let depotPrice = null;
  const depotVatMatch = compact.match(/Vergi\s*Dahil\s*Depocu\s*Satış\s*Fiyatı\s*([\d.]+,\d{2})/i);
  depotPrice = depotVatMatch ? parseTurkishMoney(depotVatMatch[1]) : null;

  let depotPriceExVat = null;
  const depotExVatMatch = compact.match(/Vergi\s*Hariç\s*Depocu\s*Satış\s*Fiyatı\s*([\d.]+,\d{2})/i);
  depotPriceExVat = depotExVatMatch ? parseTurkishMoney(depotExVatMatch[1]) : null;

  // Sipariş hesap tablosundaki net fiyat.
  let netPrice = null;
  const calculatedNet = page.locator("#calculeted_netprice").first();
  if (await calculatedNet.count()) {
    netPrice = parseTurkishMoney(await calculatedNet.innerText().catch(() => ""));
  }
  if (netPrice === null) {
    const netMatch = compact.match(/Net\s*Fiyat\s*([\d.]+,\d{2,3})/i);
    netPrice = netMatch ? parseTurkishMoney(netMatch[1]) : null;
  }

  const hasStockIcon = await page.locator(".has-stock, i[title*='Stokta Var']").count();
  const noStockIcon = await page.locator(".no-stock, i[title*='Stokta Yok']").count();
  const unavailable = noStockIcon > 0 || /Stok\s*Durumu\s*Yok|Ürün\s*Stokta\s*Yok/i.test(compact);
  const available = !unavailable && (hasStockIcon > 0 || /Stok\s*Durumu\s*Var|Ürün\s*Stokta\s*Var/i.test(compact));

  const ahCodeMatch = compact.match(/AH\s*Ürün\s*Kodu\s*:\s*(\d+)/i);

  if (!productName && depotPrice === null && !available && !unavailable) {
    console.error("ALLIANCE DEBUG URL:", page.url());
    console.error("ALLIANCE DEBUG BODY:", compact.slice(0, 3000));
    throw new Error("Alliance ürün bilgileri okunamadı. Sayfa yapısı kontrol edilmeli.");
  }

  return {
    depot: "Alliance Healthcare",
    requestedBarcode,
    barcode: requestedBarcode,
    productName,
    psf,
    depotPrice,
    depotPriceExVat,
    netPrice,
    inStock: available ? true : unavailable ? false : null,
    stockText: available ? "Stokta" : unavailable ? "Stokta yok" : "Belirsiz",
    allianceProductCode: ahCodeMatch ? ahCodeMatch[1] : null,
    checkedAt: new Date().toISOString(),
    url: page.url()
  };
}

async function checkAllianceBarcode(barcode) {
  return runPersistentDepotCheck({
    key: "alliance",
    barcode,
    loginFn: loginAlliance,
    findSearchInput: findAllianceSearchInput,
    executeSearch: async (page, input, cleanBarcode) => {
      await input.fill("");
      await input.fill(cleanBarcode);
      await input.press("Enter").catch(() => {});
      await page.waitForTimeout(900);
    },
    readProduct: readAllianceProduct
  });
}


/* -------------------------------
   SANCAK ECZA DEPOSU TARAYICI OTOMASYONU
   Salt okunur: barkod, ürün adı, PSF, depocu fiyatı, net fiyat ve stok.
-------------------------------- */

async function findSancakSearchInput(page) {
  const selectors = [
    '#search',
    'input[name="search"]',
    'input[placeholder*="Ürün adı"]',
    'input[placeholder*="barkod"]'
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try { if (await locator.isVisible()) return locator; } catch {}
    }
  }
  throw new Error("Sancak ürün arama kutusu bulunamadı.");
}

async function loginSancak(page) {
  if (!SANCAK_USERNAME || !SANCAK_PASSWORD) {
    throw new Error("SANCAK_USERNAME ve SANCAK_PASSWORD Render Environment içinde tanımlı değil.");
  }

  await page.goto(SANCAK_BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  const username = page.locator('#Customer_username').first();
  if (await username.count()) {
    await username.fill(String(SANCAK_USERNAME));
    await page.locator('#Customer_password').first().fill(String(SANCAK_PASSWORD));
    await page.locator('button.Customer_login__button, button.login_submit').first().click();
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  }

  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 60000) {
    try { return await findSancakSearchInput(page); }
    catch (error) { lastError = error; await page.waitForTimeout(1200); }
  }
  throw lastError || new Error("Sancak girişinden sonra ürün arama ekranı açılmadı.");
}

async function readSancakProduct(page, requestedBarcode) {
  const drawer = page.locator('#search-detay.siparis-detay-modal.active').first();
  const barcodeLocator = drawer.locator('.product-general-info .urun-kodu').filter({ hasText: requestedBarcode }).first();

  await barcodeLocator.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (!(await barcodeLocator.count()) || !(await barcodeLocator.isVisible().catch(() => false))) {
    throw new Error('Sancak ürün çekmecesi açılamadı veya barkod bulunamadı.');
  }

  const productName = (await drawer.locator('.urun-adi h2').first().innerText().catch(() => '')).trim();
  const psf = parseTurkishMoney(await drawer.locator('.product-general-info .list-price').first().innerText().catch(() => ''));
  const depotPrice = parseTurkishMoney(await drawer.locator('.product-general-info .sales-price').first().innerText().catch(() => ''));

  let netPrice = null;
  const selectedPayment = drawer.locator('#siparis-detay-bilgiler-offering-content ul').filter({
    has: drawer.locator('input[name="PaymentTypeSelector"]:checked')
  }).first();
  if (await selectedPayment.count()) {
    netPrice = parseTurkishMoney(await selectedPayment.locator('.net-price').first().innerText().catch(() => ''));
  }
  if (netPrice === null) {
    netPrice = parseTurkishMoney(await drawer.locator('#siparis-detay-bilgiler-offering-content .net-price').first().innerText().catch(() => ''));
  }

  const idText = await drawer.locator('.product-general-info .urun-id').first().innerText().catch(() => '');
  const expiryText = await drawer.locator('.product-general-info .miad').first().innerText().catch(() => '');
  const row = page.locator('.search-result-row.current').first();
  const unavailable = await drawer.locator('text=Stokta Yok').count() > 0 || await row.locator('.badge-sm:not(.active)').count() > 0;
  const available = !unavailable && (await row.locator('.badge-sm.active').count() > 0 || Boolean(productName));

  return {
    depot: 'Sancak Ecza Deposu',
    requestedBarcode,
    barcode: requestedBarcode,
    productName,
    psf,
    depotPrice,
    netPrice,
    inStock: available ? true : unavailable ? false : null,
    stockText: available ? 'Stokta' : unavailable ? 'Stokta yok' : 'Belirsiz',
    sancakProductId: String(idText || '').replace(/\D/g, '') || null,
    expiry: String(expiryText || '').trim() || null,
    checkedAt: new Date().toISOString(),
    url: page.url()
  };
}

async function checkSancakBarcode(barcode) {
  return runPersistentDepotCheck({
    key: 'sancak',
    barcode,
    loginFn: loginSancak,
    findSearchInput: findSancakSearchInput,
    executeSearch: async (page, input, cleanBarcode) => {
      // Önce eski çekmeceyi kapat; ardından gerçek klavye olaylarıyla arama yap.
      const closeButton = page.locator('#siparis-detay-close').first();
      if (await closeButton.isVisible().catch(() => false)) {
        await closeButton.click({ timeout: 3000 }).catch(() => {});
      }

      // Sancak zaman zaman arama kutusunun üstünde kampanya/modal katmanı bırakıyor.
      // Önce görünür modalı kapatmayı dene; kapanmazsa yalnızca tıklamayı engelleyen katmanı kaldır.
      const modalCloseSelectors = [
        '.modal-v2area button.close',
        '.modal-v2area .close',
        '.modal-v2area [data-dismiss="modal"]',
        '.modal-v2area .modal-close',
        '.modal-v2area .btn-close'
      ];
      for (const selector of modalCloseSelectors) {
        const close = page.locator(selector).first();
        if (await close.isVisible().catch(() => false)) {
          await close.click({ force: true, timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(250);
          break;
        }
      }

      await page.evaluate(() => {
        document.querySelectorAll('.modal-v2area').forEach((el) => {
          const style = window.getComputedStyle(el);
          if (style.pointerEvents !== 'none' && style.display !== 'none') {
            el.style.pointerEvents = 'none';
          }
        });
      });

      // click/fill kullanma: üst katman olsa bile değeri doğrudan yaz ve gerçek input olaylarını üret.
      await input.evaluate((el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1), bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, cleanBarcode);

      const resultRow = page.locator('.search-result-row.current').first();
      await resultRow.waitFor({ state: 'visible', timeout: 12000 });

      const drawerBarcode = page.locator('#search-detay.siparis-detay-modal.active .product-general-info .urun-kodu')
        .filter({ hasText: cleanBarcode }).first();

      // Site bazı oturumlarda çekmeceyi otomatik açmazsa sonuç adına bir kez tıkla.
      if (!(await drawerBarcode.isVisible().catch(() => false))) {
        await resultRow.locator('[data-hedef="#search-detay"], .item-name-td span').first().click({ timeout: 4000 }).catch(() => {});
      }

      await drawerBarcode.waitFor({ state: 'visible', timeout: 12000 });
    },
    readProduct: readSancakProduct
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
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  let cleaned = String(value ?? "")
    .replace(/TL|₺|%/gi, "")
    .replace(/\s/g, "")
    .trim();

  if (!cleaned) return 0;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      cleaned = cleaned.replaceAll(".", "").replace(",", ".");
    } else {
      cleaned = cleaned.replaceAll(",", "");
    }
  } else if (lastComma !== -1) {
    cleaned = cleaned.replace(",", ".");
  }

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
   TEBRP PSF TARAYICI OTOMASYONU
   Barkodla ürün detayına gider; ürün adı, barkod ve PSF okur.
-------------------------------- */

async function gotoTebrp(page, url, timeout = 45000) {
  // TEBRP bazı sayfalarda DOMContentLoaded olayını çok geç tamamlıyor.
  // İlk HTTP yanıtı gelir gelmez devam edip gerekli alanı ayrıca bekliyoruz.
  await page.goto(url, { waitUntil: "commit", timeout });
  await page.waitForTimeout(500);
}

async function loginTebrp(page) {
  if (!TEBRP_USERNAME || !TEBRP_PASSWORD) {
    throw new Error("TEBRP_USERNAME ve TEBRP_PASSWORD ortam değişkenleri tanımlı değil.");
  }

  // Mevcut oturum varsa doğrudan arama ekranı açılır; yoksa giriş sayfasına yönlenir.
  await gotoTebrp(page, TEBRP_SEARCH_URL);
  await page.locator("#araInput, #username").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});

  if (await page.locator("#araInput").isVisible().catch(() => false)) {
    return page.locator("#araInput");
  }

  // Yönlendirme tamamlanmadıysa giriş sayfasını doğrudan aç.
  if (!(await page.locator("#username").isVisible().catch(() => false))) {
    await gotoTebrp(page, TEBRP_LOGIN_URL);
  }

  await page.locator("#username").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("#password").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("#username").fill(String(TEBRP_USERNAME).trim());
  await page.locator("#password").fill(String(TEBRP_PASSWORD));
  await page.locator("#giris_butonu").click();

  // Yükleme olayını değil, gerçek arama kutusunu bekle.
  await page.locator("#araInput").waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
  if (await page.locator("#araInput").isVisible().catch(() => false)) {
    return page.locator("#araInput");
  }

  // Giriş sonrası yönlendirme oluşmadıysa korumalı sayfayı yeniden aç.
  await gotoTebrp(page, TEBRP_SEARCH_URL);
  await page.locator("#araInput").waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
  if (await page.locator("#araInput").isVisible().catch(() => false)) {
    return page.locator("#araInput");
  }

  const loginError = await page.locator("#sonuc_mesaj").textContent().catch(() => "");
  throw new Error(loginError?.trim() || `TEBRP girişi tamamlanamadı. Son adres: ${page.url()}`);
}

async function testTebrpConnection() {
  const session = await getDepotSession("tebrp", loginTebrp);
  const page = session.page;
  session.lastUsedAt = Date.now();

  if (!(await page.locator("#araInput").isVisible().catch(() => false))) {
    await closeDepotSession("tebrp");
    throw new Error("TEBRP arama ekranı açılamadı.");
  }

  return {
    ok: true,
    source: "TEBRP",
    loggedIn: true,
    currentUrl: page.url(),
    baseUrl: TEBRP_BASE_URL,
    checkedAt: new Date().toISOString()
  };
}

async function readTebrpProduct(page, requestedBarcode) {
  await page.locator("#isimHeader").waitFor({ state: "visible", timeout: 45000 });
  await page.locator("#anabilgi").waitFor({ state: "attached", timeout: 45000 });

  const raw = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const productName = clean(
      document.querySelector('#isimHeader [data-name="urun_adi"]')?.textContent ||
      document.querySelector("#isimHeader")?.textContent
    );
    const barcode = clean(document.querySelector("#barkod_img")?.textContent).replace(/\D/g, "");
    const main = document.querySelector("#anabilgi");
    const mainText = clean(main?.textContent);

    let psfText = "";
    let priceDate = "";
    let vatRate = "";

    if (main) {
      const nodes = Array.from(main.querySelectorAll("span,div"));
      const label = nodes.find((el) => /Perakende\s+Satış\s+Fiyatı/i.test(clean(el.textContent)) && clean(el.textContent).length < 80);
      if (label?.parentElement) {
        const siblings = Array.from(label.parentElement.children)
          .map((el) => clean(el.textContent))
          .filter(Boolean);
        psfText = siblings.find((text) => text !== clean(label.textContent) && /\d/.test(text)) || "";
      }
    }

    if (!psfText) {
      const match = mainText.match(/Perakende\s+Satış\s+Fiyatı\s*:?\s*[₺TL]*\s*([\d.,]+)/i);
      psfText = match?.[1] || "";
    }

    const dateMatch = mainText.match(/Fiyat\s+Tarihi\s*([0-3]?\d\/[01]?\d\/\d{4})/i);
    priceDate = dateMatch?.[1] || "";

    const vatMatch = mainText.match(/KDV\s*%?\s*(\d+(?:[.,]\d+)?)/i);
    vatRate = vatMatch?.[1] || "";

    return { productName, barcode, psfText, priceDate, vatRate, mainText: mainText.slice(0, 2500) };
  });

  const cleanRequested = String(requestedBarcode || "").replace(/\D/g, "");
  if (!raw.barcode) throw new Error("TEBRP ürün detayında barkod okunamadı.");
  if (raw.barcode !== cleanRequested) {
    throw new Error(`TEBRP barkod eşleşmedi. Aranan: ${cleanRequested}, bulunan: ${raw.barcode}`);
  }

  const psf = parseTurkishMoney(raw.psfText);
  if (psf === null || psf <= 0) {
    throw new Error("TEBRP ürün detayında Perakende Satış Fiyatı okunamadı.");
  }

  return {
    source: "TEBRP",
    requestedBarcode: cleanRequested,
    barcode: raw.barcode,
    productName: raw.productName || null,
    psf,
    psfText: raw.psfText || null,
    priceDate: raw.priceDate || null,
    vatRate: raw.vatRate ? Number(String(raw.vatRate).replace(",", ".")) : null,
    detailUrl: page.url(),
    checkedAt: new Date().toISOString()
  };
}

async function checkTebrpBarcode(barcode) {
  const cleanBarcode = String(barcode || "").replace(/\D/g, "");
  if (cleanBarcode.length < 8 || cleanBarcode.length > 14) {
    throw new Error("Geçerli bir barkod girin (8-14 rakam).");
  }

  const cached = getCachedDepotResult("tebrp", cleanBarcode);
  if (cached) return cached;

  return withDepotLock("tebrp", async () => {
    const cachedAfterWait = getCachedDepotResult("tebrp", cleanBarcode);
    if (cachedAfterWait) return cachedAfterWait;

    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const session = await getDepotSession("tebrp", loginTebrp);
        const page = session.page;
        session.lastUsedAt = Date.now();

        await gotoTebrp(page, TEBRP_SEARCH_URL);
        await page.locator("#araInput").waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
        if (!(await page.locator("#araInput").isVisible().catch(() => false))) {
          await closeDepotSession("tebrp");
          throw new Error("TEBRP oturumu kapandı; yeniden giriş gerekiyor.");
        }

        const input = page.locator("#araInput");
        await input.fill("");
        await input.fill(cleanBarcode);

        const previousUrl = page.url();
        await input.press("Enter");
        await page.waitForURL(
          (url) => url.href !== previousUrl && /operation=urun_detay/i.test(url.href),
          { timeout: 45000, waitUntil: "commit" }
        );

        const result = await readTebrpProduct(page, cleanBarcode);
        setCachedDepotResult("tebrp", cleanBarcode, result);
        return result;
      } catch (error) {
        lastError = error;
        await closeDepotSession("tebrp");
      }
    }

    throw lastError || new Error("TEBRP barkod sorgusu yapılamadı.");
  });
}

/* -------------------------------
   TEMEL ENDPOINTLER
-------------------------------- */





/* -------------------------------
   TEBRP YEREL CONNECTOR KÖPRÜSÜ
   Eczane bilgisayarı yalnızca dışarı doğru HTTPS bağlantısı kurar.
-------------------------------- */

const tebrpConnectorState = {
  lastSeenAt: 0,
  connectorId: null,
  version: null,
  busy: false,
  machineName: null,
  lastError: null
};

const tebrpConnectorQueue = [];
const tebrpConnectorJobs = new Map();

function safeTokenEqual(received, expected) {
  const a = Buffer.from(String(received || ""));
  const b = Buffer.from(String(expected || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function checkTebrpConnectorToken(req, res, next) {
  if (!TEBRP_CONNECTOR_TOKEN) {
    return res.status(503).json({ error: "TEBRP_CONNECTOR_TOKEN sunucuda tanımlı değil." });
  }

  const token = String(req.headers["x-tebrp-connector-token"] || "").trim();
  if (!safeTokenEqual(token, TEBRP_CONNECTOR_TOKEN)) {
    return res.status(401).json({ error: "Connector yetkilendirmesi başarısız." });
  }
  return next();
}

function isTebrpConnectorOnline() {
  return Boolean(
    TEBRP_CONNECTOR_TOKEN &&
    tebrpConnectorState.lastSeenAt &&
    Date.now() - tebrpConnectorState.lastSeenAt <= TEBRP_CONNECTOR_ONLINE_MS
  );
}

function updateTebrpConnectorState(body = {}) {
  tebrpConnectorState.lastSeenAt = Date.now();
  tebrpConnectorState.connectorId = String(body.connectorId || tebrpConnectorState.connectorId || "").slice(0, 100) || null;
  tebrpConnectorState.version = String(body.version || tebrpConnectorState.version || "").slice(0, 50) || null;
  tebrpConnectorState.machineName = String(body.machineName || tebrpConnectorState.machineName || "").slice(0, 100) || null;
  if (typeof body.busy === "boolean") tebrpConnectorState.busy = body.busy;
  if (body.lastError !== undefined) tebrpConnectorState.lastError = body.lastError ? String(body.lastError).slice(0, 500) : null;
}

function createTebrpConnectorJob(type, payload = {}, timeoutMs = TEBRP_CONNECTOR_JOB_TIMEOUT_MS) {
  if (!TEBRP_CONNECTOR_TOKEN) {
    return Promise.reject(new Error("TEBRP Connector sunucu anahtarı tanımlı değil."));
  }
  if (!isTebrpConnectorOnline()) {
    return Promise.reject(new Error("TEBRP Connector çevrimdışı. Eczane bilgisayarının açık ve connector uygulamasının çalışır olduğundan emin olun."));
  }

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const effectiveTimeoutMs = Math.max(10000, Number(timeoutMs) || TEBRP_CONNECTOR_JOB_TIMEOUT_MS);
  const expiresAt = createdAt + effectiveTimeoutMs;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const job = tebrpConnectorJobs.get(id);
      if (job) {
        tebrpConnectorJobs.delete(id);
        const index = tebrpConnectorQueue.findIndex((item) => item.id === id);
        if (index >= 0) tebrpConnectorQueue.splice(index, 1);
      }
      reject(new Error(`TEBRP Connector yanıt süresi doldu (${Math.round(effectiveTimeoutMs / 1000)} sn).`));
    }, effectiveTimeoutMs);

    const job = {
      id,
      type,
      payload,
      createdAt,
      expiresAt,
      timeoutMs: effectiveTimeoutMs,
      assignedAt: null,
      connectorId: null,
      resolve,
      reject,
      timer
    };

    tebrpConnectorJobs.set(id, job);
    tebrpConnectorQueue.push(job);
  });
}

async function testTebrpViaBestRoute() {
  if (TEBRP_CONNECTOR_TOKEN) {
    return createTebrpConnectorJob("test", {});
  }
  return testTebrpConnection();
}

async function checkTebrpViaBestRoute(barcode) {
  const cleanBarcode = String(barcode || "").replace(/\D/g, "");
  if (cleanBarcode.length < 8 || cleanBarcode.length > 14) {
    throw new Error("Geçerli bir barkod girin (8-14 rakam).");
  }

  const cached = getCachedDepotResult("tebrp", cleanBarcode);
  if (cached) return cached;

  let result;
  if (TEBRP_CONNECTOR_TOKEN) {
    result = await createTebrpConnectorJob("check", { barcode: cleanBarcode });
  } else {
    result = await checkTebrpBarcode(cleanBarcode);
  }

  if (result && result.barcode === cleanBarcode) {
    setCachedDepotResult("tebrp", cleanBarcode, result);
  }
  return result;
}

app.post("/api/tebrp-connector/heartbeat", checkTebrpConnectorToken, (req, res) => {
  updateTebrpConnectorState(req.body || {});
  return res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    online: true,
    queuedJobs: tebrpConnectorQueue.length
  });
});

app.get("/api/tebrp-connector/jobs/next", checkTebrpConnectorToken, (req, res) => {
  updateTebrpConnectorState({
    connectorId: req.query?.connectorId,
    version: req.query?.version,
    machineName: req.query?.machineName,
    busy: false
  });

  const now = Date.now();
  while (tebrpConnectorQueue.length) {
    const job = tebrpConnectorQueue.shift();
    if (!job || !tebrpConnectorJobs.has(job.id)) continue;
    if (job.expiresAt && now > job.expiresAt) continue;

    job.assignedAt = now;
    job.connectorId = String(req.query?.connectorId || "").slice(0, 100) || null;
    tebrpConnectorState.busy = true;

    return res.json({
      ok: true,
      job: {
        id: job.id,
        type: job.type,
        payload: job.payload,
        createdAt: new Date(job.createdAt).toISOString()
      }
    });
  }

  return res.status(204).end();
});

app.post("/api/tebrp-connector/jobs/:id/result", checkTebrpConnectorToken, (req, res) => {
  updateTebrpConnectorState({ ...(req.body?.connector || {}), busy: false, lastError: req.body?.ok === false ? req.body?.error : null });

  const id = String(req.params.id || "");
  const job = tebrpConnectorJobs.get(id);
  if (!job) {
    return res.status(404).json({ error: "İş bulunamadı veya süresi doldu." });
  }

  clearTimeout(job.timer);
  tebrpConnectorJobs.delete(id);

  if (req.body?.ok === false) {
    job.reject(new Error(String(req.body?.error || "TEBRP Connector işlemi başarısız.")));
  } else {
    job.resolve(req.body?.result ?? null);
  }

  return res.json({ ok: true });
});

/* -------------------------------
   TEBRP PSF KONTROL ENDPOINTLERİ
-------------------------------- */

app.get("/api/tebrp/status", checkAdminPassword, (req, res) => {
  return res.json({
    ok: true,
    source: "TEBRP",
    mode: TEBRP_CONNECTOR_TOKEN ? "local-connector" : "direct",
    connectorConfigured: Boolean(TEBRP_CONNECTOR_TOKEN),
    connectorOnline: isTebrpConnectorOnline(),
    connector: {
      lastSeenAt: tebrpConnectorState.lastSeenAt ? new Date(tebrpConnectorState.lastSeenAt).toISOString() : null,
      connectorId: tebrpConnectorState.connectorId,
      version: tebrpConnectorState.version,
      machineName: tebrpConnectorState.machineName,
      busy: tebrpConnectorState.busy,
      lastError: tebrpConnectorState.lastError
    },
    queuedJobs: tebrpConnectorQueue.length,
    onlineWindowMs: TEBRP_CONNECTOR_ONLINE_MS,
    baseUrl: TEBRP_BASE_URL,
    readOnly: true
  });
});

app.post("/api/tebrp/test", checkAdminPassword, async (req, res) => {
  try {
    return res.json(await testTebrpViaBestRoute());
  } catch (error) {
    console.error("TEBRP TEST ERROR:", error);
    return res.status(500).json({
      error: error?.message || "TEBRP bağlantı testi başarısız."
    });
  }
});

app.post("/api/tebrp/check", checkAdminPassword, async (req, res) => {
  try {
    const result = await checkTebrpViaBestRoute(req.body?.barcode);
    return res.json({ ok: true, result });
  } catch (error) {
    console.error("TEBRP CHECK ERROR:", error);
    return res.status(500).json({
      error: error?.message || "TEBRP barkod kontrolü yapılamadı."
    });
  }
});

app.post("/api/tebrp/check-batch", checkAdminPassword, async (req, res) => {
  const barcodes = Array.from(new Set(
    (Array.isArray(req.body?.barcodes) ? req.body.barcodes : [])
      .map((value) => String(value || "").replace(/\D/g, ""))
      .filter((value) => value.length >= 8 && value.length <= 14)
  )).slice(0, 200);

  if (!barcodes.length) {
    return res.status(400).json({ error: "Kontrol edilecek barkod bulunamadı." });
  }

  try {
    if (TEBRP_CONNECTOR_TOKEN) {
      const batchTimeoutMs = Math.max(TEBRP_CONNECTOR_JOB_TIMEOUT_MS, 60000 + barcodes.length * 75000);
      const result = await createTebrpConnectorJob("check-batch", { barcodes }, batchTimeoutMs);
      const rows = Array.isArray(result?.results) ? result.results : [];
      for (const row of rows) {
        if (row?.ok && row?.result?.barcode) setCachedDepotResult("tebrp", row.result.barcode, row.result);
      }
      return res.json({ ok: true, count: rows.length, results: rows });
    }

    const results = [];
    for (const barcode of barcodes) {
      try {
        results.push({ ok: true, result: await checkTebrpBarcode(barcode) });
      } catch (error) {
        results.push({ ok: false, requestedBarcode: barcode, error: error?.message || "Kontrol edilemedi." });
      }
    }
    return res.json({ ok: true, count: results.length, results });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "TEBRP toplu kontrolü yapılamadı." });
  }
});

/* -------------------------------
   BEK DEPO KONTROL ENDPOINTLERİ
-------------------------------- */

app.get("/api/depot/bek/status", checkAdminPassword, (req, res) => {
  return res.json({
    ok: true,
    depot: "BEK",
    configured: Boolean(BEK_USERNAME && BEK_PASSWORD),
    baseUrl: BEK_BASE_URL,
    mode: "read-only"
  });
});

app.post("/api/depot/bek/check", checkAdminPassword, async (req, res) => {
  try {
    const result = await checkBekBarcode(req.body?.barcode);
    return res.json({ ok: true, result });
  } catch (error) {
    console.error("BEK CHECK ERROR:", error);
    return res.status(500).json({
      error: error?.message || "BEK barkod kontrolü yapılamadı."
    });
  }
});

app.post("/api/depot/bek/check-batch", checkAdminPassword, async (req, res) => {
  const barcodes = Array.from(new Set(
    (Array.isArray(req.body?.barcodes) ? req.body.barcodes : [])
      .map((value) => String(value || "").replace(/\D/g, ""))
      .filter((value) => value.length >= 8 && value.length <= 14)
  )).slice(0, 10);

  if (!barcodes.length) {
    return res.status(400).json({ error: "Kontrol edilecek barkod bulunamadı." });
  }

  let browser;
  let context;
  const results = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    context = await browser.newContext({
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1440, height: 1000 }
    });

    const page = await context.newPage();
    let searchInput = await loginBek(page);

    for (const barcode of barcodes) {
      try {
        await page.goto(BEK_BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        searchInput = await findBekSearchInput(page);
        await searchInput.fill("");
        await searchInput.fill(barcode);
        await searchInput.press("Enter");
        results.push({ ok: true, ...(await readBekProduct(page, barcode)) });

        // Bir sonraki arama için üst arama kutusunu yeniden bul.
        searchInput = await findBekSearchInput(page);
      } catch (error) {
        results.push({ ok: false, requestedBarcode: barcode, error: error?.message || "Kontrol edilemedi." });
        try {
          await page.goto(BEK_BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
          searchInput = await loginBek(page);
        } catch {}
      }
    }

    return res.json({ ok: true, count: results.length, results });
  } catch (error) {
    console.error("BEK BATCH ERROR:", error);
    return res.status(500).json({ error: error?.message || "BEK toplu kontrolü yapılamadı." });
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
});


/* -------------------------------
   İSKOOP DEPO KONTROL ENDPOINTLERİ
-------------------------------- */

app.get("/api/depot/iskoop/status", checkAdminPassword, (req, res) => {
  return res.json({
    ok: true,
    depot: "İSKOOP",
    configured: Boolean(ISKOOP_USERNAME && ISKOOP_PASSWORD),
    baseUrl: ISKOOP_BASE_URL,
    mode: "read-only"
  });
});

app.post("/api/depot/iskoop/check", checkAdminPassword, async (req, res) => {
  try {
    const result = await checkIskoopBarcode(req.body?.barcode);
    return res.json({ ok: true, result });
  } catch (error) {
    console.error("ISKOOP CHECK ERROR:", error);
    return res.status(500).json({
      error: error?.message || "İSKOOP barkod kontrolü yapılamadı."
    });
  }
});

app.post("/api/depot/iskoop/check-batch", checkAdminPassword, async (req, res) => {
  const barcodes = Array.from(new Set(
    (Array.isArray(req.body?.barcodes) ? req.body.barcodes : [])
      .map((value) => String(value || "").replace(/\D/g, ""))
      .filter((value) => value.length >= 8 && value.length <= 14)
  )).slice(0, 10);

  if (!barcodes.length) {
    return res.status(400).json({ error: "Kontrol edilecek barkod bulunamadı." });
  }

  let browser;
  let context;
  const results = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    context = await browser.newContext({
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1440, height: 1000 }
    });

    const page = await context.newPage();
    let searchInput = await loginIskoop(page);

    for (const barcode of barcodes) {
      try {
        await page.goto(ISKOOP_BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        searchInput = await findIskoopSearchInput(page);
        await searchInput.fill("");
        await searchInput.fill(barcode);
        await searchInput.press("Enter");
        results.push({ ok: true, ...(await readIskoopProduct(page, barcode)) });
        searchInput = await findIskoopSearchInput(page);
      } catch (error) {
        results.push({ ok: false, requestedBarcode: barcode, error: error?.message || "Kontrol edilemedi." });
        try {
          await page.goto(ISKOOP_BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
          searchInput = await loginIskoop(page);
        } catch {}
      }
    }

    return res.json({ ok: true, count: results.length, results });
  } catch (error) {
    console.error("ISKOOP BATCH ERROR:", error);
    return res.status(500).json({ error: error?.message || "İSKOOP toplu kontrolü yapılamadı." });
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
});



/* -------------------------------
   CENCORA ALLIANCE HEALTHCARE DEPO KONTROL ENDPOINTLERİ
-------------------------------- */

app.get("/api/depot/alliance/status", checkAdminPassword, (req, res) => {
  return res.json({
    ok: true,
    depot: "Alliance Healthcare",
    configured: Boolean(ALLIANCE_PHARMACY_CODE && ALLIANCE_USERNAME && ALLIANCE_PASSWORD),
    baseUrl: ALLIANCE_BASE_URL,
    mode: "read-only"
  });
});

app.post("/api/depot/alliance/check", checkAdminPassword, async (req, res) => {
  try {
    const result = await checkAllianceBarcode(req.body?.barcode);
    return res.json({ ok: true, result });
  } catch (error) {
    console.error("ALLIANCE CHECK ERROR:", error);
    return res.status(500).json({
      error: error?.message || "Alliance barkod kontrolü yapılamadı."
    });
  }
});

app.post("/api/depot/alliance/check-batch", checkAdminPassword, async (req, res) => {
  const barcodes = Array.from(new Set(
    (Array.isArray(req.body?.barcodes) ? req.body.barcodes : [])
      .map((value) => String(value || "").replace(/\D/g, ""))
      .filter((value) => value.length >= 8 && value.length <= 14)
  )).slice(0, 10);

  if (!barcodes.length) {
    return res.status(400).json({ error: "Kontrol edilecek barkod bulunamadı." });
  }

  const results = [];
  for (const barcode of barcodes) {
    try {
      results.push({ ok: true, ...(await checkAllianceBarcode(barcode)) });
    } catch (error) {
      results.push({
        ok: false,
        requestedBarcode: barcode,
        error: error?.message || "Kontrol edilemedi."
      });
    }
  }

  return res.json({ ok: true, count: results.length, results });
});


/* -------------------------------
   SANCAK VE TÜM DEPOLAR ENDPOINTLERİ
-------------------------------- */
app.get("/api/depot/sancak/status", checkAdminPassword, (req, res) => {
  res.json({ ok: true, depot: "Sancak Ecza Deposu", configured: Boolean(SANCAK_USERNAME && SANCAK_PASSWORD), baseUrl: SANCAK_BASE_URL, mode: "read-only" });
});

app.post("/api/depot/sancak/check", checkAdminPassword, async (req, res) => {
  try { return res.json({ ok: true, result: await checkSancakBarcode(req.body?.barcode) }); }
  catch (error) { console.error("SANCAK CHECK ERROR:", error); return res.status(500).json({ error: error?.message || "Sancak barkod kontrolü yapılamadı." }); }
});

app.post("/api/depot/all/check", checkAdminPassword, async (req, res) => {
  const barcode = String(req.body?.barcode || "").replace(/\D/g, "");
  if (barcode.length < 8 || barcode.length > 14) {
    return res.status(400).json({ error: "Geçerli bir barkod girin." });
  }

  const checks = [
    ["BEK", checkBekBarcode],
    ["İSKOOP", checkIskoopBarcode],
    ["Alliance Healthcare", checkAllianceBarcode],
    ["Sancak Ecza Deposu", checkSancakBarcode]
  ];

  const startedAt = Date.now();
  const settled = await Promise.allSettled(
    checks.map(async ([depot, fn]) => {
      const result = await fn(barcode);
      return { depot, result };
    })
  );

  const results = settled.map((entry, index) => {
    const depot = checks[index][0];
    if (entry.status === "fulfilled") {
      return { ok: true, depot, result: entry.value.result };
    }
    return {
      ok: false,
      depot,
      error: entry.reason?.message || "Kontrol edilemedi."
    };
  });

  const successfulResults = results.filter((item) => item.ok);
  const allSuccessful = successfulResults.length === checks.length;
  const anyInStock = successfulResults.some((item) => item.result?.inStock === true);
  const allOutOfStock = allSuccessful && successfulResults.every((item) => item.result?.inStock === false);

  return res.json({
    ok: true,
    barcode,
    mode: "parallel",
    durationMs: Date.now() - startedAt,
    allSuccessful,
    anyInStock,
    allOutOfStock,
    stockDecision: anyInStock ? "available" : allOutOfStock ? "out_of_stock" : "uncertain",
    results,
    checkedAt: new Date().toISOString()
  });
});


app.get("/", (req, res) => {
  res.json({
    status: "CLAVIS AI backend aktif",
    health: "/health",
    adminLogin: "/api/admin-login",
    adminSession: "/api/admin-session",
    tebrpStatus: "/api/tebrp/status",
    tebrpTest: "/api/tebrp/test",
    tebrpCheck: "/api/tebrp/check",
    tebrpCheckBatch: "/api/tebrp/check-batch",
    shopifyAdminTest: "/api/shopify-admin-test",
    shopifyProducts: "/api/shopify-products",
    adminProductsFull: "/api/admin-products-full",
    productOperations: "/api/product-operations",
    priceAudit: "/api/price-audit",
    costSheet: "/api/cost-sheet",
    updateVariant: "/api/update-variant-basic",
    updateProductTitle: "/api/update-product-title",
    updateInventoryItem: "/api/update-inventory-item",
    shopifyLocations: "/api/shopify-locations",
    updateInventoryQuantity: "/api/update-inventory-quantity",
    updateProductStatus: "/api/update-product-status",
    bulkProductAction: "/api/bulk-product-action",
    orderWebhook: "/api/shopify-order-webhook"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use(express.urlencoded({ extended: true }));

/* -------------------------------
   SHOPIFY ORDER WEBHOOK
   VakıfBank yönlendirme kaldırıldı.
-------------------------------- */

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

    return res.status(200).json({
      status: "ok",
      message: "Sipariş webhook alındı. Ödeme yönlendirmesi Shopify/iyzico tarafından yönetiliyor.",
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

app.post("/api/update-product-title", checkAdminPassword, async (req, res) => {
  try {
    const productId = String(req.body?.productId || "").trim();
    const title = String(req.body?.title || "").replace(/\s+/g, " ").trim();

    if (!productId) {
      return res.status(400).json({ error: "productId eksik." });
    }

    if (title.length < 2 || title.length > 255) {
      return res.status(400).json({
        error: "Ürün adı 2-255 karakter arasında olmalı."
      });
    }

    const data = await shopifyGraphQL(
      `
      mutation productUpdate($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product {
            id
            title
            handle
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      {
        product: {
          id: productId,
          title
        }
      }
    );

    const errors = data.productUpdate?.userErrors || [];
    if (errors.length) {
      return res.status(400).json({
        error: errors.map((item) => item.message).join(", ")
      });
    }

    return res.json({
      status: "ok",
      product: data.productUpdate?.product || null
    });
  } catch (error) {
    console.error("UPDATE PRODUCT TITLE ERROR:", error);
    return res.status(500).json({
      error: error.message || "Shopify ürün adı güncellenemedi."
    });
  }
});

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


app.get("/api/shopify-locations", checkAdminPassword, async (req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query {
        locations(first: 50) {
          edges {
            node {
              id
              name
              isActive
              fulfillsOnlineOrders
            }
          }
        }
      }
    `);

    const locations = (data.locations?.edges || [])
      .map((edge) => edge.node)
      .filter((location) => location?.isActive);

    return res.json({
      status: "ok",
      count: locations.length,
      locations
    });
  } catch (error) {
    console.error("SHOPIFY LOCATIONS ERROR:", error);
    return res.status(500).json({
      error: error.message || "Shopify konumları alınamadı."
    });
  }
});

app.post("/api/update-inventory-quantity", checkAdminPassword, async (req, res) => {
  try {
    const { inventoryItemId, locationId, quantity, compareQuantity } = req.body || {};

    if (!inventoryItemId) {
      return res.status(400).json({ error: "inventoryItemId eksik." });
    }

    if (!locationId) {
      return res.status(400).json({ error: "locationId eksik." });
    }

    const numericQuantity = Number(quantity);
    if (!Number.isInteger(numericQuantity) || numericQuantity < 0) {
      return res.status(400).json({
        error: "quantity sıfır veya pozitif tam sayı olmalı."
      });
    }

    const quantityInput = {
      inventoryItemId,
      locationId,
      quantity: numericQuantity
    };

    if (compareQuantity !== undefined && compareQuantity !== null && compareQuantity !== "") {
      const numericCompareQuantity = Number(compareQuantity);
      if (!Number.isInteger(numericCompareQuantity) || numericCompareQuantity < 0) {
        return res.status(400).json({
          error: "compareQuantity sıfır veya pozitif tam sayı olmalı."
        });
      }
      quantityInput.compareQuantity = numericCompareQuantity;
    }

    const input = {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: quantityInput.compareQuantity === undefined,
      referenceDocumentUri: `clavis://inventory-correction/${Date.now()}`,
      quantities: [quantityInput]
    };

    const data = await shopifyGraphQL(
      `
      mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup {
            createdAt
            reason
            referenceDocumentUri
            changes {
              name
              delta
              quantityAfterChange
            }
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

    const payload = data.inventorySetQuantities;
    const errors = payload?.userErrors || [];

    if (errors.length) {
      return res.status(400).json({
        error: errors.map((e) => e.message).join(", "),
        userErrors: errors
      });
    }

    return res.json({
      status: "ok",
      inventoryItemId,
      locationId,
      quantity: numericQuantity,
      adjustment: payload?.inventoryAdjustmentGroup || null
    });
  } catch (error) {
    console.error("UPDATE INVENTORY QUANTITY ERROR:", error);
    return res.status(500).json({
      error: error.message || "Stok miktarı güncellenemedi."
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
