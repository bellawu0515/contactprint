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
          // 查找引用常见：{text:"xxx"} 或 {text_arr:["xxx"]}
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
  // 整数：千分位；小数：保留2位
  if (Number.isInteger(n)) return n.toLocaleString("zh-CN");
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateCn(v: any) {
  // 1) number（飞书日期常为 ms）
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

  // 2) array/object -> text
  const s0 = toText(v);
  const s = s0.replace(/\.0+$/g, "").trim(); // 处理 "1758....0"

  if (/^\d{13}$/.test(s)) return fmtDateCn(Number(s));
  if (/^\d{10}$/.test(s)) return fmtDateCn(Number(s) * 1000);

  // 3) 2025-12-24 / 2025/12/24
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;

  return s; // 如果本来就是一串说明文字，就原样返回
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

// ==================== 关联/查找：产品图与付款条件兜底 ====================

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

      for (const v of Object.values(fields)) {
        const t = toText(v);
        if (t) return t;
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

      // 先按候选字段名找
      for (const k of candidateKeys) {
        if (k in fields) {
          const tok = pickFileToken((fields as any)[k]);
          if (tok) return tok;
        }
      }
      // 再扫全表字段兜底
      for (const v of Object.values(fields)) {
        const tok = pickFileToken(v);
        if (tok) return tok;
      }
    }
  }
  return null;
}

// 5) 下载图片二进制 -> data url
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

  // 你当前目录：public/fonts/
  const regularRel = "public/fonts/NotoSansSC-Regular.ttf";
  const boldRel = "public/fonts/NotoSansSC-Bold.ttf";

  // 注意：ttf 的 mime 用 font/ttf
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

// -------------------- build contract html --------------------
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
  qtyUnit: string; // ✅数量单位（来自 SKU 主档：数量单位）

  unitPrice: string;
  totalPrice: string;

  plannedDelivery: string; // ✅预计交货期（来自“预计交货日期”）
  productRemark: string; // 产品备注（文字）
  paymentTerms: string; // 付款条件

  productImgDataUrl?: string;

  // 字体 CSS（注入 @font-face）
  fontCss?: string;
}) {
  const totalNum = num(p.totalPrice);
  const totalUpper = totalNum ? rmbUppercase(totalNum) : "";

  const spec = p.sku ? `${p.sku}（详见附件技术要求）` : `（详见附件技术要求）`;

  // ✅计划交货期：为空时不输出 “：,”
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
    .title{
      text-align:center;
      font-weight:700;
      font-size:22px;
      margin:0 0 10px 0;
      letter-spacing:1px;
    }
    .meta{ margin:0 0 10px 0; }
    .meta div{ margin:2px 0; }

    .para{ margin:6px 0; }

    table{
      width:100%;
      border-collapse:collapse;
      margin:10px 0 10px 0;
      table-layout:fixed;
    }
    th,td{
      border:2px solid #111;
      padding:10px 10px;
      vertical-align:top;
      word-break:break-word;
    }
    th{ text-align:center; font-weight:700; }

    .section-title{
      font-weight:700;
      font-size:18px;
      margin:16px 0 8px 0;
    }

    .imgbox{
      margin:10px 0 8px 0;
      display:flex;
      gap:12px;
      align-items:flex-start;
    }
    .imgbox .label{
      font-weight:700;
      min-width:70px;
    }
    .imgbox img{
      max-width:260px;
      max-height:200px;
      object-fit:contain;
      border:1px solid #ddd;
      padding:6px;
    }

    .sign-row{
      display:flex;
      justify-content:space-between;
      gap:22px;
      margin-top:18px;
      font-size:14px;
    }
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

  <div class="para">1.1 附件与确认：本合同附件（包括但不限于技术要求、包装要求、封样/确认样品记录、箱唛/贴标文件、AQL检验标准等）构成本合同不可分割部分。供方不得擅自变更材料、结构、工艺、包装或配件；确需变更的，应经需方书面（含盖章扫描件、邮件/企业微信/飞书等可追溯方式）确认后方可执行。</div>
  <div class="para">1.2 分批出货与交接：供方每批出货前应向需方提交《出货清单》（型号/数量/箱数/毛净重/箱规/批次号等）及出货照片，经需方书面确认后方可出货；否则因此造成的错发、漏发、贴标错误等损失由供方承担。</div>

  <div class="section-title">二、质量保证、验货与不良处理</div>
  <div class="para">2.1 质量与合规：供方保证产品符合封样、双方确认的技术/包装要求及适用的出口合规要求。因产品质量、配件缺失、贴标错误或知识产权问题导致外商/平台/消费者索赔的，由供方承担相应经济责任；若责任可归因于需方提供的贴标/唛头文件错误或指示不当的，供方不承担该部分责任。</div>
  <div class="para">2.2 验货：初检在供方工厂进行。需方自行安排出货前检验（按照AQL进行）。如检验结论为不合格（需返工/重工/补料），则由供方承担该次检验及复检相关合理费用。</div>
  <div class="para">2.3 异议与质保：需方/外商/最终客户在收货后12个月内提出非人为质量异议的，需方应在发现问题后30日内向供方提交证据（照片/视频/平台报告/第三方报告等）。供方应在收到证据后5个工作日内提出处理方案并执行。</div>
  <div class="para">2.4 不良品处理（折中标准）：<br/>
  （1）功能性次品（如无法安装、孔位错、承重不达标等）：次品率≤2%时，供方免费补寄配件或随下次货柜发往美国售后仓；次品率＞2%时，超出部分按对应问题部件/整机货值（以本合同含税单价折算）赔偿，并承担美国境内合理退换运费（需方提供凭证）。<br/>
  （2）外观/包装次品（如漆面划伤、污渍、泡棉破损、外箱破损、贴标错误、配件包装错漏等）：次品率≤3%时，供方免费补寄对应配件/外箱/贴标或按需方要求折价处理；次品率＞3%时，超出部分按整机货值（以本合同含税单价折算）赔偿，并承担因此产生的合理返工及复检费用（需方提供凭证）。<br/>
  （3）返工与复原：所有返工、抽检后的产品，打包带须复原、塑料袋无破损、无脏污、无胶印；不符合者视为不合格品并按本条处理。</div>
  <div class="para">2.5 售后备件：供方应按需方要求提供易损件备件（如脚垫、螺丝包、泡棉等），具体数量与随货方式以附件或需方书面通知为准。</div>

  <div class="section-title">三、交货、结算与票据</div>
  <div class="para">3.1 交货期：供方应按需方书面分批计划出货。供方不得以内部物料准备、打样、模具等原因单方延迟。</div>
  <div class="para">3.2 发票与单据：供方须于发货后10个工作日内开具合法有效的13%增值税专用发票。增值税发票/送货单/合同信息必须一致（品名、型号、数量、双方抬头等）。</div>
  <div class="para">3.3 生产过程信息：供方提供生产过程关键节点照片/视频，便于需方抽查确认。</div>

  <div class="section-title">四、双方责任与违约处理</div>
  <div class="para">4.1 供方责任：按时、按质、按量交货；承担因质量问题、配件缺失、贴标错误等引起的直接损失及可预见的合理间接损失（以需方提供凭证为准）。</div>
  <div class="para">4.2 需方责任：按约支付货款；及时提供包装唛头、贴标文件等资料；提供准确的入仓/集货地址及收货信息。</div>
  <div class="para">4.3 解除与退款：因供方严重违约（包括但不限于延迟超过10日且未达成书面延期协议、擅自量产未确认样品、重大质量不合格）导致解除合同的，供方应在解除通知送达后5个工作日内退还需方已支付款项；若供方已发生合格产品且需方同意接收的，双方可另行结算。</div>

  <div class="section-title">五、不可抗力与争议解决</div>
  <div class="para">5.1 不可抗力：因地震、洪水、火灾、战争、政府行为、重大传染病等不可抗力导致不能或暂时不能履约的，受影响方应在事件发生后5日内书面通知对方，并在合理期限内提供官方证明。双方可协商延期履行或部分/全部免除责任。</div>
  <div class="para">5.2 争议解决：本合同适用中华人民共和国法律。因本合同产生的争议，双方应先友好协商；协商不成，任一方可向合同签订地（杭州市临安区）有管辖权的人民法院提起诉讼。</div>

  <div class="section-title">六、其他</div>
  <div class="para">6.1 本合同及附件一式两份，供需双方各执一份，具有同等法律效力。</div>
  <div class="para">6.2 对本合同的任何修改、补充、确认样品、技术变更、交期调整等，均须双方书面（含盖章扫描件、双方确认的邮件/企业微信/飞书等可追溯方式）确认后方为有效。</div>
  <div class="para">6.3 未尽事宜，按国家法律法规及行业惯例执行，或由双方另行签署补充协议。</div>
  <div class="para">6.4 知识产权与合规：供方保证其生产过程、材料、工艺及交付物不侵犯任何第三方知识产权，并符合出口目的国及平台合理合规要求。如发生第三方权利主张或合规追责，由供方负责处理并承担由此给需方造成的损失（含平台扣款、下架损失、合理律师费/和解费等，以凭证为准）。</div>
  <div class="para">6.5 保密：双方对在合作中获知的对方商业信息、产品设计资料、价格条款、客户信息等负有保密义务，未经对方书面同意不得向第三方披露；法律法规或监管要求披露的除外。</div>
  <div class="para">6.6 专用模具/工装：如需方支付或参与支付模具/工装费用，相关模具/工装及其成果权益归需方所有。供方应妥善保管，不得用于为第三方生产相同或近似产品；合作终止时，需方有权要求供方返还或按需方指示处置。</div>
  <div class="para">6.7 分包限制：供方不得未经需方书面同意将本合同产品的关键工序或整机生产分包/转包给第三方。</div>

  <div class="para">（以下无正文）</div>

  <div class="sign-row">
    <div class="sign-col">
      供方（盖章）：${escapeHtml(p.supplierName)}<br/>
      授权代表：__________　　日期：____年__月__日
    </div>
    <div class="sign-col">
      需方（盖章）：${escapeHtml(p.buyerName)}<br/>
      授权代表：__________　　日期：____年__月__日
    </div>
  </div>

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

  // 本地（Mac）
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

    // 关键：等字体加载完（否则中文容易空白/乱码）
    await page.evaluate(async () => {
      // @ts-ignore
      if (document.fonts && document.fonts.ready) {
        // @ts-ignore
        await document.fonts.ready;
      }
    });

    await new Promise((r) => setTimeout(r, 200)); // 再给一点渲染缓冲

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

// -------------------- upload pdf as bitable_file media --------------------
async function uploadPdfToBitable(appToken: string, pdf: Buffer, fileName: string) {
  const FormDataAny: any = (globalThis as any).FormData;
  const BlobAny: any = (globalThis as any).Blob;
  if (!FormDataAny || !BlobAny) throw new Error("Missing FormData/Blob in runtime (need Node 18+)");

  // Default to uploading into the bitable itself. If you still get 403 (1061004),
  // set FEISHU_UPLOAD_PARENT_NODE / FEISHU_UPLOAD_PARENT_TYPE in Vercel env to a node your app can edit.
  const parentType = process.env.FEISHU_UPLOAD_PARENT_TYPE || "bitable_file";
  const parentNode = process.env.FEISHU_UPLOAD_PARENT_NODE || appToken;

  const form: any = new FormDataAny();
  form.append("file_name", fileName);
  form.append("parent_type", parentType);
  form.append("parent_node", parentNode);
  form.append("size", String(pdf.length));
  form.append("file", new BlobAny([pdf], { type: "application/pdf" }), fileName);

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
      `Upload PDF failed: ${res.status} code=${data?.code ?? "?"} msg=${data?.msg ?? ""} parent_type=${parentType} parent_node~=${nodeHint} data=${JSON.stringify(data)}`
    );
  }
  return fileToken as string;
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
    if (!recordId) {
      res.status(400).json({ ok: false, error: "Missing record_id" });
      return;
    }

    const appToken = process.env.FEISHU_APP_TOKEN!;
    const tableId = process.env.FEISHU_CONTRACT_TABLE_ID!;
    const attachmentField = process.env.FEISHU_CONTRACT_ATTACHMENT_FIELD || "合同附件";

    // ✅ env 只做兜底（避免查找引用没回填时炸）
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

    // 合同台账字段映射（你可按真实字段名加/改）
    const contractNo = toText(pickField(fields, ["合同号", "合同编号"]) || "");
    const sku = toText(pickField(fields, ["产品SKU", "SKU", "型号/规格"]) || "");
    const productName = toText(pickField(fields, ["产品名称", "品名"]) || "");

    const supplierName = toText(pickField(fields, ["供应商名称", "供方"]) || "");
    const supplierContact = toText(pickField(fields, ["供应商联系人", "联系人"]) || "");
    const supplierPhone = toText(pickField(fields, ["供应商联系电话", "联系电话"]) || "");

    // ✅采购方：单项选择，直接 toText 就行
    const buyerName = toText(pickField(fields, ["采购方", "需方"]) || "");

    // ✅采购方联系人/联系方式：合同台账里是“查找引用字段”，优先取这里
    const buyerContact = toText(pickField(fields, ["采购方联系人"]) || "") || buyerContactFallback;
    const buyerPhone = toText(pickField(fields, ["采购方联系方式", "采购方联系电话"]) || "") || buyerPhoneFallback;

    const qty = toText(pickField(fields, ["数量", "采购数量"]) || "");
    const unitPrice = fmtMoneyWithComma(
      pickField(fields, ["出厂含税单价（元/台）", "出厂含税单价", "含税出厂单价", "含税单价"]) || ""
    );
    const totalPrice = fmtMoneyWithComma(pickField(fields, ["采购总价", "合同总价", "金额（元）", "金额"]) || "");

    // ✅计划交货期（合同台账字段：预计交货日期）
    const plannedDeliveryRaw = pickField(fields, ["预计交货日期"]);
    const plannedDelivery = plannedDeliveryRaw ? fmtDateCn(plannedDeliveryRaw) : "";

    // 产品备注：文字字段（合同台账里已有）
    const productRemark = toText(pickField(fields, ["产品备注", "备注", "产品说明"]) || "");

    // 付款方式：飞书里叫「付款条件」
    const paymentTermsRaw = pickField(fields, ["付款条件", "付款方式", "账期"]);
    let paymentTerms = toText(paymentTermsRaw);

    // 如果付款条件是关联/引用，可能本值空，沿 record_ids 去取
    if (!paymentTerms) {
      const links = extractLinkItems(paymentTermsRaw);
      if (links.length) {
        paymentTerms = await resolveTextFromLinkedRecords(appToken, links, ["付款条件", "付款方式", "账期"]);
      }
    }

    // 签订日期：字段优先，其次当天
    const signDateRaw = pickField(fields, ["签订日期"]);
    const signDate = signDateRaw ? fmtDateCn(signDateRaw) : fmtDateCn(Date.now());

    // ===================== 产品图 & 数量单位（查找引用来自 SKU 主档） =====================
    const contractImageField = process.env.FEISHU_PRODUCT_IMAGE_FIELD || "产品图";
    const skuLinkField = process.env.FEISHU_SKU_LINK_FIELD || "SKU";
    const skuImageField = process.env.FEISHU_SKU_IMAGE_FIELD || "产品图";

    // 取 SKU 关联值（用于取数量单位、产品图）
    const skuVal = pickField(fields, [skuLinkField, "产品SKU", "产品SKU/规格"]);

    // ✅数量单位：从 SKU 主档取字段「数量单位」
    let qtyUnit = "";
    const skuLinksForUnit = extractLinkItems(skuVal);
    if (skuLinksForUnit.length) {
      qtyUnit = await resolveTextFromLinkedRecords(appToken, skuLinksForUnit, ["数量单位"]);
    }
    if (!qtyUnit) qtyUnit = "台";

    // 产品图：先取合同台账自己的产品图字段，否则顺着 SKU 去取
    const imgVal = pickField(fields, [contractImageField, "产品图片", "产品主图", "参考图", "图片"]);
    let imgToken = pickFileToken(imgVal);

    // 如果合同台账的产品图是“引用/关联到 SKU 主档”，需要顺着 SKU 关联记录去取
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
    if (imgToken) {
      productImgDataUrl = await downloadMediaToDataUrl(imgToken);
    }

    // 关键：注入字体（解决中文乱码/空白）
    const fontCss = getEmbeddedFontCss();

    // 2) 生成 PDF
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
      qtyUnit, // ✅一定要传
      unitPrice,
      totalPrice,
      plannedDelivery, // ✅一定要传
      productRemark,
      paymentTerms,
      productImgDataUrl,
      fontCss,
    });

    const pdf = await htmlToPdfBuffer(html);

    // 3) 上传 PDF 得到 file_token
    const safeContractNo = (contractNo || "合同").replace(/[\\/:*?"<>|]/g, "_");
    const safeSku = (sku || "").replace(/[\\/:*?"<>|]/g, "_");
    const fileName = `${safeContractNo}${safeSku ? "_" + safeSku : ""}.pdf`;

    const fileToken = await uploadPdfToBitable(appToken, pdf, fileName);

    // 4) 回写到“合同附件”
    const updatePayload = {
      fields: {
        [attachmentField]: [{ file_token: fileToken, name: fileName }],
      },
    };

    await feishuFetch(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(updatePayload),
      }
    );

    res.status(200).json({ ok: true, record_id: recordId, file_token: fileToken, file_name: fileName });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
