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
  // 飞书也可能 200 但 code!=0
  if (json && typeof json === "object" && "code" in json && json.code) {
    throw new Error(`Feishu API ${path0} error: ${JSON.stringify(json)}`);
  }
  return json;
}

// -------------------- value normalize --------------------
function toText(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);

  // 常见：数组（人员/多选/关联/查找引用）
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
          if (typeof (it as any).timestamp === "number") return String((it as any).timestamp);
        }
        return "";
      })
      .filter(Boolean);

    return parts.join("，");
  }

  // 单对象：{text}/{name}/{value}/{timestamp}
  if (typeof v === "object") {
    if (Array.isArray((v as any).text_arr)) return (v as any).text_arr.join("");
    if (typeof (v as any).text === "string") return (v as any).text;
    if (typeof (v as any).name === "string") return (v as any).name;
    if (typeof (v as any).value === "string") return (v as any).value;
    if (typeof (v as any).value === "number") return String((v as any).value);
    if (typeof (v as any).timestamp === "number") return String((v as any).timestamp);
  }

  return "";
}

function pickField(fields: Record<string, any>, keys: string[]) {
  for (const k of keys) {
    if (k in fields) return fields[k];
  }
  return undefined;
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

  const s0 = toText(v);
  const s = s0.replace(/\.0+$/g, "").trim();

  if (/^\d{13}$/.test(s)) return fmtDateCn(Number(s));
  if (/^\d{10}$/.test(s)) return fmtDateCn(Number(s) * 1000);

  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;

  return s;
}

// -------------------- money to RMB uppercase --------------------
function rmbUppercase(amount: number) {
  if (!Number.isFinite(amount)) return "";
  const CN_NUM = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  const CN_UNIT = ["", "拾", "佰", "仟"];
  const CN_GROUP = ["", "万", "亿", "兆"];
  const CN_DEC = ["角", "分"];

  const fixed = Math.round(amount * 100);
  const integer = Math.floor(fixed / 100);
  const dec = fixed % 100;

  const intStr = String(integer);
  let out = "";
  let groupIndex = 0;

  for (let i = intStr.length; i > 0; i -= 4) {
    const start = Math.max(0, i - 4);
    const part = intStr.slice(start, i);
    let partOut = "";
    let zeroFlag = false;

    for (let j = 0; j < part.length; j++) {
      const n = Number(part[j]);
      const unitIndex = part.length - 1 - j;

      if (n === 0) {
        zeroFlag = true;
      } else {
        if (zeroFlag) partOut += "零";
        zeroFlag = false;
        partOut += CN_NUM[n] + CN_UNIT[unitIndex];
      }
    }

    partOut = partOut.replace(/零+$/g, "");
    if (partOut) out = partOut + CN_GROUP[groupIndex] + out;
    groupIndex++;
  }

  out = out || "零";
  out += "元";

  if (dec === 0) return out + "整";

  const jiao = Math.floor(dec / 10);
  const fen = dec % 10;
  if (jiao > 0) out += CN_NUM[jiao] + CN_DEC[0];
  if (fen > 0) out += CN_NUM[fen] + CN_DEC[1];
  return out;
}

function escapeHtml(s: string) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ==================== 关联/查找：产品图与引用字段兜底 ====================

function looksLikeId(s: string) {
  return /^(optr|rec|tbl)[A-Za-z0-9]+$/.test((s || "").trim());
}

// 1) 从字段值里尽量找 file_token（附件/查找引用附件）
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

// 2) 若字段是“关联记录/引用”，常见结构：[{table_id, record_ids:[...]}]
function extractLinkItems(v: any): Array<{ table_id: string; record_ids: string[] }> {
  const out: Array<{ table_id: string; record_ids: string[] }> = [];

  const pushIf = (obj: any) => {
    const table_id = obj?.table_id;
    const record_ids = obj?.record_ids;
    if (typeof table_id === "string" && Array.isArray(record_ids) && record_ids.length) {
      out.push({ table_id, record_ids: record_ids.map((x: any) => String(x)) });
    }
  };

  if (Array.isArray(v)) {
    for (const it of v) if (it && typeof it === "object") pushIf(it);
  } else if (v && typeof v === "object") {
    pushIf(v);
  }

  return out;
}

// 3) 读取关联记录：拿指定字段文本（付款条件等）
async function resolveTextFromLinkedRecords(
  appToken: string,
  links: Array<{ table_id: string; record_ids: string[] }>,
  candidateKeys: string[]
) {
  for (const link of links) {
    for (const rid of link.record_ids) {
      const rec = await feishuFetch(
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(link.table_id)}/records/${encodeURIComponent(rid)}`,
        { method: "GET" }
      );
      const fields = rec?.data?.record?.fields || {};

      for (const k of candidateKeys) {
        if (k in fields) {
          const t = toText((fields as any)[k]);
          if (t) return t;
        }
      }

      // 兜底：扫全字段，取第一个可读文本
      for (const v of Object.values(fields)) {
        const t = toText(v);
        if (t && !looksLikeId(t)) return t;
      }
    }
  }
  return "";
}

// 4) 读取关联记录：拿附件 file_token（产品图）
async function resolveAttachmentFromLinkedRecords(
  appToken: string,
  links: Array<{ table_id: string; record_ids: string[] }>,
  candidateKeys: string[] = ["产品图", "产品图片", "主图", "图片", "参考图"]
) {
  for (const link of links) {
    for (const rid of link.record_ids) {
      const rec = await feishuFetch(
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(link.table_id)}/records/${encodeURIComponent(rid)}`,
        { method: "GET" }
      );
      const fields = rec?.data?.record?.fields || {};

      for (const k of candidateKeys) {
        if (k in fields) {
          const tok = pickFileToken((fields as any)[k]);
          if (tok) return tok;
        }
      }

      for (const v of Object.values(fields)) {
        const tok = pickFileToken(v);
        if (tok) return tok;
      }
    }
  }
  return null;
}

// 5) 下载图片二进制 -> data url（只给 PDF 用）
async function downloadMediaToDataUrl(fileToken: string) {
  const token = await getTenantAccessToken();
  const res = await fetch(
    `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Download media failed: ${res.status} ${t}`);
  }
  const ct = res.headers.get("content-type") || "application/octet-stream";
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  const b64 = buf.toString("base64");
  return `data:${ct};base64,${b64}`;
}

// ==================== Font embedding (解决 PDF 中文乱码) ====================
let cachedFontCss: string | null = null;

function fileToDataUrl(relPath: string, mime: string) {
  const abs = path.join(process.cwd(), relPath);
  const buf = fs.readFileSync(abs);
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

function getEmbeddedFontCss() {
  if (cachedFontCss) return cachedFontCss;

  const regularRel = "public/fonts/NotoSansSC-Regular.ttf";
  const boldRel = "public/fonts/NotoSansSC-Bold.ttf";

  const regularDataUrl = fileToDataUrl(regularRel, "font/ttf");
  const boldDataUrl = fileToDataUrl(boldRel, "font/ttf");

  cachedFontCss = `
    @font-face{
      font-family:"NotoSansSC";
      src:url("${regularDataUrl}") format("truetype");
      font-weight:400;
      font-style:normal;
      font-display:swap;
    }
    @font-face{
      font-family:"NotoSansSC";
      src:url("${boldDataUrl}") format("truetype");
      font-weight:700;
      font-style:normal;
      font-display:swap;
    }
  `.trim();

  return cachedFontCss;
}

// -------------------- build contract html (PDF) --------------------
function buildContractHtml(p: {
  contractNo: string;
  signDate: string;
  signPlace: string;

  supplierName: string;
  supplierContact: string;
  supplierPhone: string;

  buyerName: string;
  buyerContact: string;
  buyerPhone: string;

  productName: string;
  sku: string;

  qty: string;
  qtyUnit: string;

  unitPrice: string;
  totalPrice: string;

  plannedDelivery: string;
  productRemark: string;
  paymentTerms: string;

  productImgDataUrl?: string;
  fontCss?: string;
}) {
  const totalNum = num(p.totalPrice);
  const totalUpper = totalNum ? rmbUppercase(totalNum) : "";

  const spec = p.sku ? `${p.sku}（详见附件技术要求）` : `（详见附件技术要求）`;

  const plannedDeliveryLine = p.plannedDelivery
    ? `计划交货期：${escapeHtml(p.plannedDelivery)}，具体以需方通知的出货计划为准`
    : `计划交货期：具体以需方通知的出货计划为准`;

  const qtyUnitSafe = (p.qtyUnit || "").trim() || "台";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    ${p.fontCss || ""}
    *{ box-sizing:border-box; }
    body{
      font-family:"NotoSansSC","PingFang SC","Microsoft YaHei",Arial,sans-serif;
      color:#000;
      margin:0;
      padding:24px 26px;
      background:#fff;
      font-size:14px;
      line-height:1.75;
    }
    .title{ text-align:center; font-weight:700; font-size:22px; margin:0 0 10px 0; letter-spacing:1px; }
    .meta{ margin:0 0 10px 0; }
    .meta div{ margin:2px 0; }
    .para{ margin:6px 0; }
    table{ width:100%; border-collapse:collapse; margin:10px 0; table-layout:fixed; }
    th,td{ border:2px solid #111; padding:10px; vertical-align:top; word-break:break-word; }
    th{ text-align:center; font-weight:700; }
    .section-title{ font-weight:700; font-size:18px; margin:16px 0 8px 0; }
    .imgbox{ margin:10px 0 8px 0; display:flex; gap:12px; align-items:flex-start; }
    .imgbox .label{ font-weight:700; min-width:70px; }
    .imgbox img{ max-width:260px; max-height:200px; object-fit:contain; border:1px solid #ddd; padding:6px; }
    .sign-row{ display:flex; justify-content:space-between; gap:22px; margin-top:18px; font-size:14px; }
    .sign-col{ flex:1; }
  </style>
</head>
<body>
  <div class="title">出口产品购销合同</div>

  <div class="meta">
    <div>合同编号：${escapeHtml(p.contractNo)}</div>
    <div>签订日期：${escapeHtml(p.signDate)}</div>
    <div>签订地点：${escapeHtml(p.signPlace)}</div>
  </div>

  <div class="para">根据《中华人民共和国民法典》及相关法律规定，供需双方在平等、自愿、公平、诚实信用基础上，就供方供应需方出口产品事宜协商一致，订立本合同，双方共同遵守。</div>

  <div class="para">
    供方：${escapeHtml(p.supplierName)}<br/>
    法定代表人/授权代表：${escapeHtml(p.supplierContact)}　　电话：${escapeHtml(p.supplierPhone)}<br/>
    需方：${escapeHtml(p.buyerName)}<br/>
    法定代表人/授权代表：${escapeHtml(p.buyerContact)}　　电话：${escapeHtml(p.buyerPhone)}
  </div>

  <div class="section-title">一、品名、规格、数量、金额、交货期</div>

  <table>
    <thead>
      <tr>
        <th style="width:18%;">品名</th>
        <th style="width:24%;">型号/规格</th>
        <th style="width:12%;">数量（${escapeHtml(qtyUnitSafe)}）</th>
        <th style="width:16%;">出厂含税单价（元/${escapeHtml(qtyUnitSafe)}）</th>
        <th style="width:14%;">金额（元）</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${escapeHtml(p.productName)}</td>
        <td>${escapeHtml(spec)}</td>
        <td>${escapeHtml(p.qty)}</td>
        <td>${escapeHtml(p.unitPrice)}</td>
        <td>${escapeHtml(p.totalPrice)}</td>
      </tr>
    </tbody>
  </table>

  <div class="para">合同总价：人民币${escapeHtml(p.totalPrice)}元（大写：${escapeHtml(totalUpper)}），含13%增值税。</div>
  <div class="para">交货地点：供方指定，货物风险与损失责任在双方签收《送货单/交接单》时转移。</div>
  <div class="para">${plannedDeliveryLine}</div>
  <div class="para">产品备注：${escapeHtml(p.productRemark)}</div>

  ${p.productImgDataUrl ? `
    <div class="imgbox">
      <div class="label">产品图：</div>
      <img src="${p.productImgDataUrl}" alt="产品图" />
    </div>
  ` : ``}

  <div class="section-title">三、交货、结算与票据</div>
  <div class="para">3.1 付款条件：${escapeHtml(p.paymentTerms)}</div>

</body>
</html>`;
}

// -------------------- html -> pdf buffer --------------------
async function getLaunchOptions() {
  const isVercel = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_VERSION;

  if (isVercel) {
    return {
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    };
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

    await page.evaluate(async () => {
      // @ts-ignore
      if (document.fonts && document.fonts.ready) {
        // @ts-ignore
        await document.fonts.ready;
      }
    });

    await new Promise((r) => setTimeout(r, 200));

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// -------------------- render docx from template (docxtemplater) --------------------
async function renderDocxFromTemplate(templateAbsPath: string, data: Record<string, any>) {
  const [{ default: PizZip }, { default: Docxtemplater }] = await Promise.all([
    import("pizzip"),
    import("docxtemplater"),
  ]);

  const content = fs.readFileSync(templateAbsPath, "binary");
  const zip = new PizZip(content);

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
    nullGetter: () => "", // ✅ 缺变量就空字符串，避免 Multi error
  });

  doc.render(data);

  return doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Buffer;
}

// -------------------- upload file (pdf/docx/...) --------------------
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
    const nodeHint = typeof parentNode === "string" ? parentNode.slice(0, 10) : "";
    throw new Error(
      `Upload file failed: ${res.status} code=${data?.code ?? "?"} msg=${data?.msg ?? ""} parent_type=${parentType} parent_node~=${nodeHint} data=${JSON.stringify(data)}`
    );
  }
  return fileToken as string;
}

async function uploadPdfToBitable(appToken: string, pdf: Buffer, fileName: string) {
  return uploadFileToBitable(appToken, pdf, fileName, "application/pdf");
}

// -------------------- main handler --------------------
export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }

    // 简单鉴权：防止别人乱打你接口
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
    const format = String(body?.format || "docx").toLowerCase(); // 默认输出 Word
    if (!recordId) {
      res.status(400).json({ ok: false, error: "Missing record_id" });
      return;
    }

    const appToken = process.env.FEISHU_APP_TOKEN!;
    const tableId = process.env.FEISHU_CONTRACT_TABLE_ID!;
    const attachmentField = process.env.FEISHU_CONTRACT_ATTACHMENT_FIELD || "合同附件";

    const buyerContactFallback = process.env.BUYER_CONTACT_NAME || "胡红亮";
    const buyerPhoneFallback = process.env.BUYER_CONTACT_PHONE || "";
    const signPlace = process.env.SIGN_PLACE || "临安";

    if (!appToken || !tableId) throw new Error("Missing FEISHU_APP_TOKEN / FEISHU_CONTRACT_TABLE_ID");

    // 1) 拉取合同记录
    const rec = await feishuFetch(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      { method: "GET" }
    );

    const fields = rec?.data?.record?.fields || {};

    // ===================== 付款条件/尾款条件（引用字段）=====================
    const payCondRaw = pickField(fields, ["付款条件"]);
    let paymentTerms = toText(payCondRaw);

    if (!paymentTerms || looksLikeId(paymentTerms)) {
      const links = extractLinkItems(payCondRaw);
      if (links.length) {
        paymentTerms = await resolveTextFromLinkedRecords(appToken, links, [
          "付款条件",
          "条款名称",
          "规则名称",
          "名称",
          "标题",
          "文本",
        ]);
      }
    }
    paymentTerms = paymentTerms || "";

    const tailCondRaw = pickField(fields, ["尾款条件"]);
    let tailPay = toText(tailCondRaw);

    if (!tailPay || looksLikeId(tailPay)) {
      const links = extractLinkItems(tailCondRaw);
      if (links.length) {
        tailPay = await resolveTextFromLinkedRecords(appToken, links, [
          "尾款条件",
          "条款名称",
          "规则名称",
          "名称",
          "标题",
          "文本",
        ]);
      }
    }
    tailPay = tailPay || "";
    // ===================== /付款条件/尾款条件 =====================

    // 合同台账字段映射
    const contractNo = toText(pickField(fields, ["合同号", "合同编号"]) || "");
    const sku = toText(pickField(fields, ["产品SKU", "SKU", "型号/规格"]) || "");
    const productName = toText(pickField(fields, ["产品名称", "品名"]) || "");

    const supplierName = toText(pickField(fields, ["供应商名称", "供方"]) || "");
    const supplierContact = toText(pickField(fields, ["供应商联系人", "联系人"]) || "");
    const supplierPhone = toText(pickField(fields, ["供应商联系电话", "联系电话"]) || "");

    const buyerName = toText(pickField(fields, ["采购方", "需方"]) || "");
    const buyerContact = toText(pickField(fields, ["采购方联系人"]) || "") || buyerContactFallback;
    const buyerPhone = toText(pickField(fields, ["采购方联系方式", "采购方联系电话"]) || "") || buyerPhoneFallback;

    const qty = toText(pickField(fields, ["数量", "采购数量"]) || "");
    const unitPrice = fmtMoneyWithComma(
      pickField(fields, ["出厂含税单价（元/台）", "出厂含税单价", "含税出厂单价", "含税单价"]) || ""
    );
    const totalPrice = fmtMoneyWithComma(pickField(fields, ["采购总价", "合同总价", "金额（元）", "金额"]) || "");

    const plannedDeliveryRaw = pickField(fields, ["预计交货日期"]);
    const plannedDelivery = plannedDeliveryRaw ? fmtDateCn(plannedDeliveryRaw) : "";

    const productRemark = toText(pickField(fields, ["产品备注", "备注", "产品说明"]) || "");

    // 签订日期：字段优先，其次当天
    const signDateRaw = pickField(fields, ["签订日期"]);
    const signDate = signDateRaw ? fmtDateCn(signDateRaw) : fmtDateCn(Date.now());

    // ===================== 产品图 & 数量单位（查找引用来自 SKU 主档） =====================
    const contractImageField = process.env.FEISHU_PRODUCT_IMAGE_FIELD || "产品图";
    const skuLinkField = process.env.FEISHU_SKU_LINK_FIELD || "SKU";
    const skuImageField = process.env.FEISHU_SKU_IMAGE_FIELD || "产品图";

    const skuVal = pickField(fields, [skuLinkField, "产品SKU", "产品SKU/规格"]);

    let qtyUnit = "";
    const skuLinksForUnit = extractLinkItems(skuVal);
    if (skuLinksForUnit.length) {
      qtyUnit = await resolveTextFromLinkedRecords(appToken, skuLinksForUnit, ["数量单位"]);
    }
    if (!qtyUnit) qtyUnit = "台";

    const imgVal = pickField(fields, [contractImageField, "产品图片", "产品主图", "参考图", "图片"]);
    let imgToken = pickFileToken(imgVal);

    if (!imgToken) {
      const skuLinks = extractLinkItems(skuVal);
      if (skuLinks.length) {
        imgToken = await resolveAttachmentFromLinkedRecords(appToken, skuLinks, [
          skuImageField,
          "产品图片",
          "主图",
          "图片",
          "参考图",
        ]);
      }
    }

    let productImgDataUrl: string | undefined = undefined;
    if (format === "pdf" && imgToken) {
      productImgDataUrl = await downloadMediaToDataUrl(imgToken);
    }

    const fontCss = format === "pdf" ? getEmbeddedFontCss() : "";

    // ===================== 生成文件 =====================
    if (format === "pdf") {
      const html = buildContractHtml({
        contractNo,
        signDate,
        signPlace,
        supplierName,
        supplierContact,
        supplierPhone,
        buyerName,
        buyerContact,
        buyerPhone,
        productName,
        sku,
        qty,
        qtyUnit,
        unitPrice,
        totalPrice,
        plannedDelivery,
        productRemark,
        paymentTerms,
        productImgDataUrl,
        fontCss,
      });

      const pdf = await htmlToPdfBuffer(html);

      const safeContractNo = (contractNo || "合同").replace(/[\\/:*?"<>|]/g, "_");
      const safeSku = (sku || "").replace(/[\\/:*?"<>|]/g, "_");
      const fileName = `${safeContractNo}${safeSku ? "_" + safeSku : ""}.pdf`;

      const fileToken = await uploadPdfToBitable(appToken, pdf, fileName);

      await feishuFetch(
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            fields: {
              [attachmentField]: [{ file_token: fileToken, name: fileName }],
            },
          }),
        }
      );

      res.status(200).json({ ok: true, record_id: recordId, file_token: fileToken, file_name: fileName, format: "pdf" });
      return;
    }

    // ===== Word (docx) =====
    const templateName = process.env.CONTRACT_TEMPLATE_NAME || "采购合同_模板_变量版.docx";
    const templatePath = path.join(process.cwd(), "templates", templateName);

    const prepayText = toText(pickField(fields, ["预付款金额", "预付款", "预付金额"]) || "");
    const prepayNum = num(prepayText);

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
      采购总价大写: (() => {
        const n = num(totalPrice);
        return n ? rmbUppercase(n) : "";
      })(),

      净重: toText(pickField(fields, ["净重"]) || ""),
      毛重: toText(pickField(fields, ["毛重"]) || ""),
      包装尺寸: toText(pickField(fields, ["包装尺寸"]) || ""),
      产品备注: productRemark,

      付款条件: paymentTerms,
      预付款金额: prepayText,
      预付款金额大写: prepayNum ? rmbUppercase(prepayNum) : "",
      尾款条件: tailPay,
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
        body: JSON.stringify({
          fields: {
            [attachmentField]: [{ file_token: fileToken, name: fileName }],
          },
        }),
      }
    );

    res.status(200).json({ ok: true, record_id: recordId, file_token: fileToken, file_name: fileName, format: "docx" });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      details: e?.properties?.errors?.map((x: any) => x?.properties?.explanation || x?.message || x) || null,
    });
  }
}
