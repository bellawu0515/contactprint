// api/feishu/print-contract.ts
import type { IncomingMessage } from "http";
import fs from "fs";
import path from "path";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

// -------------------- helpers: read json body --------------------
async function readJson(req: any) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks: Buffer[] = [];
  const msg = req as IncomingMessage;
  for await (const chunk of msg) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// -------------------- Feishu token cache --------------------
let cachedToken: { token: string; expireAt: number } | null = null;

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expireAt > now + 60_000) return cachedToken.token;

  const appId = process.env.FEISHU_APP_ID!;
  const appSecret = process.env.FEISHU_APP_SECRET!;
  if (!appId || !appSecret) throw new Error("Missing FEISHU_APP_ID / FEISHU_APP_SECRET");

  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const data = await res.json();
  if (!res.ok || !data?.tenant_access_token) {
    throw new Error(`Get tenant_access_token failed: ${res.status} ${JSON.stringify(data)}`);
  }

  const token = data.tenant_access_token as string;
  const expire = Number(data.expire || 3600);
  cachedToken = { token, expireAt: now + expire * 1000 };
  return token;
}

async function feishuFetch(path0: string, init?: RequestInit) {
  const token = await getTenantAccessToken();
  const url = `https://open.feishu.cn/open-apis${path0}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) throw new Error(`Feishu API ${path0} failed: ${res.status} ${JSON.stringify(json)}`);
  if (json && typeof json === "object" && "code" in json && json.code) {
    throw new Error(`Feishu API ${path0} error: ${JSON.stringify(json)}`);
  }
  return json;
}

// -------------------- normalize helpers --------------------
function isLikelyId(s: string) {
  return /^(optr|rec|tbl)[A-Za-z0-9]+$/.test((s || "").trim());
}

function normalizeKey(s: string) {
  return String(s || "").replace(/\s+/g, "").trim();
}

function pickFieldLoose(fields: Record<string, any>, keys: string[]) {
  // exact first
  for (const k of keys) if (k in fields) return fields[k];
  // loose match (remove spaces)
  const fieldKeys = Object.keys(fields);
  for (const k of keys) {
    const nk = normalizeKey(k);
    const hit = fieldKeys.find((fk) => normalizeKey(fk) === nk);
    if (hit) return (fields as any)[hit];
  }
  return undefined;
}

function toText(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);

  if (Array.isArray(v)) {
    const parts = v
      .map((it) => {
        if (it === null || it === undefined) return "";
        if (typeof it === "string" || typeof it === "number") return String(it);
        if (typeof it === "object") {
          if (Array.isArray((it as any).text_arr)) return (it as any).text_arr.join("");
          if (typeof (it as any).text === "string") return (it as any).text;
          if (typeof (it as any).name === "string") return (it as any).name;
          if (typeof (it as any).value === "string") return (it as any).value;
          if (typeof (it as any).value === "number") return String((it as any).value);
        }
        return "";
      })
      .filter(Boolean);

    return parts.join("，");
  }

  if (typeof v === "object") {
    if (Array.isArray((v as any).text_arr)) return (v as any).text_arr.join("");
    if (typeof (v as any).text === "string") return (v as any).text;
    if (typeof (v as any).name === "string") return (v as any).name;
    if (typeof (v as any).value === "string") return (v as any).value;
    if (typeof (v as any).value === "number") return String((v as any).value);
  }

  return "";
}

// 尽量抽“可读文本”（忽略 optr/rec/tbl/undefined）
function extractReadableText(v: any): string {
  const out: string[] = [];
  const seen = new Set<any>();

  const visit = (x: any) => {
    if (x === null || x === undefined) return;
    if (seen.has(x)) return;
    if (typeof x === "object") seen.add(x);

    if (typeof x === "string") {
      const s = x.trim();
      if (!s) return;
      if (isLikelyId(s)) return;
      if (s === "undefined" || s === "null") return;
      out.push(s);
      return;
    }
    if (typeof x === "number") {
      out.push(String(x));
      return;
    }
    if (Array.isArray(x)) {
      x.forEach(visit);
      return;
    }
    if (typeof x === "object") {
      const prefer = ["text", "name", "label", "display_value", "displayValue", "value"];
      for (const k of prefer) if (k in x) visit((x as any)[k]);

      const preferList = ["text_arr", "textArr", "values", "value_list", "valueList", "lookup_values", "lookupValues"];
      for (const k of preferList) if (k in x) visit((x as any)[k]);

      for (const val of Object.values(x)) visit(val);
    }
  };

  visit(v);
  return Array.from(new Set(out)).join("，");
}

function scoreText(text: string, patterns: string[]) {
  let s = 0;
  for (const p of patterns) if (text.includes(p)) s += 10;
  // prefer not too long and not too short
  s += Math.min(text.length, 60) / 60;
  return s;
}

function bestTextFromFields(fields: Record<string, any>, patterns: string[]) {
  const candidates: string[] = [];
  for (const v of Object.values(fields)) {
    const t = extractReadableText(v);
    if (t && !isLikelyId(t)) candidates.push(t);
  }
  if (!candidates.length) return "";
  candidates.sort((a, b) => scoreText(b, patterns) - scoreText(a, patterns));
  return candidates[0] || "";
}

function num(v: any) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[,\s￥¥]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoneyWithComma(v: any) {
  const n = num(v);
  if (!n) return "";
  if (Number.isInteger(n)) return n.toLocaleString("zh-CN");
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateCn(v: any) {
  if (typeof v === "number") {
    const ms = v > 10_000_000_000 ? v : v * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      const parts = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }).formatToParts(d);
      const y = parts.find((p) => p.type === "year")?.value || "";
      const m = parts.find((p) => p.type === "month")?.value || "";
      const dd = parts.find((p) => p.type === "day")?.value || "";
      return `${y}年${m}月${dd}日`;
    }
  }
  const s = toText(v).trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
  return s;
}

// -------------------- link / attachment helpers --------------------
function extractLinkItems(v: any): Array<{ table_id: string; record_ids: string[] }> {
  const out: Array<{ table_id: string; record_ids: string[] }> = [];
  const pushIf = (obj: any) => {
    const table_id = obj?.table_id;
    const record_ids = obj?.record_ids;
    if (typeof table_id === "string" && Array.isArray(record_ids) && record_ids.length) {
      out.push({ table_id, record_ids: record_ids.map((x: any) => String(x)) });
    }
  };
  if (Array.isArray(v)) for (const it of v) if (it && typeof it === "object") pushIf(it);
  else if (v && typeof v === "object") pushIf(v);
  return out;
}

function pickFileToken(v: any): string | null {
  if (!v) return null;

  if (Array.isArray(v)) {
    for (const it of v) {
      const t =
        (it as any)?.file_token ||
        (it as any)?.fileToken ||
        (it as any)?.token ||
        (it as any)?.file_token_list?.[0] ||
        null;
      if (t) return String(t);
    }
  }

  if (typeof v === "object") {
    const t =
      (v as any).file_token ||
      (v as any).fileToken ||
      (v as any).token ||
      (v as any).file_token_list?.[0] ||
      null;
    if (t) return String(t);
  }

  return null;
}

async function downloadMediaToBuffer(fileToken: string): Promise<Buffer> {
  const token = await getTenantAccessToken();
  const res = await fetch(
    `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Download media failed: ${res.status} ${t}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// 解析引用文本：优先直接抽；否则遍历所有引用字段并在来源记录中找最匹配文本
async function resolveTextAny(
  appToken: string,
  raw: any,
  allFields: Record<string, any>,
  patterns: string[]
): Promise<string> {
  // 1) direct
  const direct = extractReadableText(raw);
  if (direct && !isLikelyId(direct)) return direct;

  // 2) follow the raw's links if possible
  const tryLinks = async (links: Array<{ table_id: string; record_ids: string[] }>) => {
    const LIMIT = 12;
    let cnt = 0;
    for (const link of links) {
      for (const rid of link.record_ids) {
        cnt++;
        if (cnt > LIMIT) break;
        const rec2 = await feishuFetch(
          `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(link.table_id)}/records/${encodeURIComponent(rid)}`,
          { method: "GET" }
        );
        const f2 = rec2?.data?.record?.fields || {};
        const best = bestTextFromFields(f2, patterns);
        if (best) return best;
      }
    }
    return "";
  };

  const rawLinks = extractLinkItems(raw);
  if (rawLinks.length) {
    const best = await tryLinks(rawLinks);
    if (best) return best;
  }

  // 3) fallback: scan contract record fields for any value that already contains patterns
  // (in case field name isn't 付款条件 but value exists)
  const bestInSelf = bestTextFromFields(allFields, patterns);
  if (bestInSelf) return bestInSelf;

  // 4) final fallback: scan ALL link fields in the contract record, fetch their records and pick best
  const linkValues = Object.values(allFields);
  let tried = 0;
  for (const v of linkValues) {
    const links = extractLinkItems(v);
    if (!links.length) continue;
    tried++;
    if (tried > 8) break; // limit
    const best = await tryLinks(links);
    if (best) return best;
  }

  return "";
}

// 解析引用图片 token：优先直接 token；否则扫描所有字段/所有引用来源记录
async function resolveImageTokenAny(appToken: string, raw: any, allFields: Record<string, any>): Promise<string | null> {
  // 1) direct token
  const t0 = pickFileToken(raw);
  if (t0) return t0;

  // 2) scan all fields direct token
  for (const v of Object.values(allFields)) {
    const t = pickFileToken(v);
    if (t) return t;
  }

  // 3) follow raw's links first
  const scanLinksForToken = async (links: Array<{ table_id: string; record_ids: string[] }>) => {
    const LIMIT = 12;
    let cnt = 0;
    for (const link of links) {
      for (const rid of link.record_ids) {
        cnt++;
        if (cnt > LIMIT) break;
        const rec2 = await feishuFetch(
          `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(link.table_id)}/records/${encodeURIComponent(rid)}`,
          { method: "GET" }
        );
        const f2 = rec2?.data?.record?.fields || {};
        // scan all fields for file token
        for (const vv of Object.values(f2)) {
          const tok = pickFileToken(vv);
          if (tok) return tok;
        }
      }
    }
    return null;
  };

  const rawLinks = extractLinkItems(raw);
  if (rawLinks.length) {
    const tok = await scanLinksForToken(rawLinks);
    if (tok) return tok;
  }

  // 4) scan ALL link fields in contract
  let tried = 0;
  for (const v of Object.values(allFields)) {
    const links = extractLinkItems(v);
    if (!links.length) continue;
    tried++;
    if (tried > 10) break;
    const tok = await scanLinksForToken(links);
    if (tok) return tok;
  }

  return null;
}

// -------------------- docx render with image module --------------------
const TRANSPARENT_1X1_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64"
);

async function renderDocxFromTemplate(templateAbsPath: string, data: Record<string, any>) {
  const [{ default: PizZip }, { default: Docxtemplater }, ImageModuleFree, sizeOfMod] = await Promise.all([
    import("pizzip"),
    import("docxtemplater"),
    import("docxtemplater-image-module-free"),
    import("image-size"),
  ]);

  const ImageModule: any = (ImageModuleFree as any).default || ImageModuleFree;
  const sizeOf: any = (sizeOfMod as any).default || sizeOfMod;

  const content = fs.readFileSync(templateAbsPath, "binary");
  const zip = new PizZip(content);

  const imageModule = new ImageModule({
    centered: true,
    fileType: "docx",
    getImage: (tagValue: any) => {
      if (Buffer.isBuffer(tagValue)) return tagValue;
      return TRANSPARENT_1X1_PNG;
    },
    getSize: (img: Buffer) => {
      const dim = sizeOf(img) || {};
      const w0 = Number(dim.width || 260);
      const h0 = Number(dim.height || 200);
      const maxW = 260;
      const w = Math.min(w0, maxW);
      const h = Math.round((h0 * w) / (w0 || maxW));
      return [w, h];
    },
  });

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
    nullGetter: () => "",
    modules: [imageModule],
  });

  doc.render(data);

  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

// -------------------- upload file to Feishu drive --------------------
async function uploadFileToBitable(appToken: string, buf: Buffer, fileName: string, mime: string) {
  const FormDataAny: any = (globalThis as any).FormData;
  const BlobAny: any = (globalThis as any).Blob;
  if (!FormDataAny || !BlobAny) throw new Error("Missing FormData/Blob in runtime (need Node 18+)");

  const parentType = process.env.FEISHU_UPLOAD_PARENT_TYPE || "bitable_file";
  const parentNode = process.env.FEISHU_UPLOAD_PARENT_NODE || appToken;

  const form: any = new FormDataAny();
  form.append("file_name", fileName);
  form.append("parent_type", parentType);
  form.append("parent_node", parentNode);
  form.append("size", String(buf.length));
  form.append("file", new BlobAny([buf], { type: mime }), fileName);

  const token = await getTenantAccessToken();
  const res = await fetch("https://open.feishu.cn/open-apis/drive/v1/medias/upload_all", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const rawText = await res.text();
  let data: any = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = { raw: rawText };
  }

  const fileToken = data?.data?.file_token;
  if (!res.ok || !fileToken) {
    throw new Error(`Upload file failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return fileToken as string;
}

// -------------------- optional pdf --------------------
async function getLaunchOptions() {
  const isVercel = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_VERSION;
  if (isVercel) {
    return { args: chromium.args, executablePath: await chromium.executablePath(), headless: true };
  }
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === "darwin" ? macChrome : undefined),
    headless: true,
  };
}

async function htmlToPdfBuffer(html: string) {
  const launchOpt = await getLaunchOptions();
  const browser = await puppeteer.launch(launchOpt as any);
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// -------------------- main handler --------------------
export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }

    // token (optional)
    const token = process.env.WEBHOOK_TOKEN;
    if (token) {
      const got = (req.headers["x-webhook-token"] as string | undefined) || (req.headers["X-Webhook-Token"] as any);
      if (got !== token) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
    }

    const body = await readJson(req);
    const recordId = body?.record_id || body?.recordId;
    const format = String(body?.format || "docx").toLowerCase();

    if (!recordId) {
      res.status(400).json({ ok: false, error: "Missing record_id" });
      return;
    }

    const appToken = process.env.FEISHU_APP_TOKEN!;
    const tableId = process.env.FEISHU_CONTRACT_TABLE_ID!;
    const attachmentField = process.env.FEISHU_CONTRACT_ATTACHMENT_FIELD || "合同附件";
    if (!appToken || !tableId) throw new Error("Missing FEISHU_APP_TOKEN / FEISHU_CONTRACT_TABLE_ID");

    // 1) get record
    const rec = await feishuFetch(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      { method: "GET" }
    );
    const fields = rec?.data?.record?.fields || {};

    // 2) resolve terms (smart)
    const payRaw = pickFieldLoose(fields, ["付款条件", "付款方式", "账期明细", "帐期明细"]);
    const tailRaw = pickFieldLoose(fields, ["尾款条件", "尾款", "账期", "帐期"]);

    const paymentTerms = await resolveTextAny(appToken, payRaw, fields, ["预付", "无预付", "N+", "%", "账期"]);
    const tailPay = await resolveTextAny(appToken, tailRaw, fields, ["出货", "月", "付清", "尾款", "N+"]);

    // 3) resolve image token (smart)
    const contractImageField = process.env.FEISHU_PRODUCT_IMAGE_FIELD || "产品图";
    const imgRaw = pickFieldLoose(fields, [contractImageField, "产品图片", "产品主图", "参考图", "图片"]);
    const imgToken = await resolveImageTokenAny(appToken, imgRaw, fields);

    // 4) other fields
    const contractNo = toText(pickFieldLoose(fields, ["合同号", "合同编号"]) || "");
    const sku = toText(pickFieldLoose(fields, ["产品SKU", "SKU", "型号/规格"]) || "");
    const productName = toText(pickFieldLoose(fields, ["产品名称", "品名"]) || "");

    const supplierName = toText(pickFieldLoose(fields, ["供应商名称", "供方"]) || "");
    const supplierContact = toText(pickFieldLoose(fields, ["供应商联系人", "联系人"]) || "");
    const supplierPhone = toText(pickFieldLoose(fields, ["供应商联系电话", "联系电话"]) || "");

    const buyerName = toText(pickFieldLoose(fields, ["采购方", "需方"]) || "");
    const buyerContact = toText(pickFieldLoose(fields, ["采购方联系人"]) || "");
    const buyerPhone = toText(pickFieldLoose(fields, ["采购方联系方式", "采购方联系电话"]) || "");

    const qty = toText(pickFieldLoose(fields, ["数量", "采购数量"]) || "");
    const unitPrice = fmtMoneyWithComma(
      pickFieldLoose(fields, ["出厂含税单价（元/台）", "出厂含税单价", "含税出厂单价", "含税单价"]) || ""
    );
    const totalPrice = fmtMoneyWithComma(pickFieldLoose(fields, ["采购总价", "合同总价", "金额（元）", "金额"]) || "");

    const plannedDeliveryRaw = pickFieldLoose(fields, ["预计交货日期"]);
    const plannedDelivery = plannedDeliveryRaw ? fmtDateCn(plannedDeliveryRaw) : "";

    const productRemark = toText(pickFieldLoose(fields, ["产品备注", "备注", "产品说明"]) || "");

    const signDateRaw = pickFieldLoose(fields, ["签订日期"]);
    const signDate = signDateRaw ? fmtDateCn(signDateRaw) : fmtDateCn(Date.now());

    const qtyUnit = "台";

    const prepayText = toText(pickFieldLoose(fields, ["预付款金额", "预付款", "预付金额"]) || "");

    // 5) generate
    if (format === "pdf") {
      const html = `
        <html><body style="font-family:Arial">
          <h3>合同 ${contractNo}</h3>
          <p>付款条件：${paymentTerms}</p>
          <p>尾款条件：${tailPay}</p>
        </body></html>
      `;
      const pdf = await htmlToPdfBuffer(html);

      const safeContractNo = (contractNo || "合同").replace(/[\\/:*?"<>|]/g, "_");
      const safeSku = (sku || "").replace(/[\\/:*?"<>|]/g, "_");
      const fileName = `${safeContractNo}${safeSku ? "_" + safeSku : ""}.pdf`;

      const fileToken = await uploadFileToBitable(appToken, pdf, fileName, "application/pdf");

      await feishuFetch(
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ fields: { [attachmentField]: [{ file_token: fileToken, name: fileName }] } }),
        }
      );

      res.status(200).json({ ok: true, format: "pdf", file_name: fileName, file_token: fileToken, record_id: recordId });
      return;
    }

    // docx
    const templateName = process.env.CONTRACT_TEMPLATE_NAME || "采购合同_模板_变量版.docx";
    const templatePath = path.join(process.cwd(), "templates", templateName);

    const productImgBuf = imgToken ? await downloadMediaToBuffer(imgToken) : null;

    const docxBuf = await renderDocxFromTemplate(templatePath, {
      合同号: contractNo,
      下单日期: signDate,
      预计交货日期: plannedDelivery,

      供应商名称: supplierName,
      供应商联系人: supplierContact,
      供应商联系电话: supplierPhone,

      采购方: buyerName,
      采购方联系人: buyerContact,
      采购方联系电话: buyerPhone,

      产品名称: productName,
      产品sku: sku,
      采购数量: qty,
      数量单位: qtyUnit,
      含税出厂单价: unitPrice,
      采购总价: totalPrice,

      产品备注: productRemark,

      付款条件: paymentTerms || "",
      预付款金额: prepayText || "",
      尾款条件: tailPay || "",

      // template: {%%product_img}
      product_img: productImgBuf || null,
    });

    const safeContractNo = (contractNo || "合同").replace(/[\\/:*?"<>|]/g, "_");
    const safeSku = (sku || "").replace(/[\\/:*?"<>|]/g, "_");
    const fileName = `${safeContractNo}${safeSku ? "_" + safeSku : ""}.docx`;

    const fileToken = await uploadFileToBitable(
      appToken,
      docxBuf,
      fileName,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    await feishuFetch(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ fields: { [attachmentField]: [{ file_token: fileToken, name: fileName }] } }),
      }
    );

    res.status(200).json({ ok: true, format: "docx", file_name: fileName, file_token: fileToken, record_id: recordId });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
