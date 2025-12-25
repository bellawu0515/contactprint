
export interface SKU {
  id: string;
  fields: {
    "SKU编号": string;
    "品名": string;
    "规格": string;
    "分类": string;
    "单位": string;
    "当前库存": number;
    "安全库存": number;
  }
}

export interface Supplier {
  id: string;
  fields: {
    "供应商名称": string;
    "联系人": string;
    "电话": string;
    "等级": string;
    "主营产品": string;
    "状态": string;
  }
}

export interface Quotation {
  id: string;
  fields: {
    "SKU编号": string;
    "供应商": string;
    "含税单价": number;
    "生效日期": string;
    "账期": string;
  }
}

export interface Contract {
  id: string;
  fields: {
    "合同编号": string;
    "合同名称": string;
    "供应商": string;
    "合同金额": number;
    "签约日期": string;
    "到期日期": string;
    "合同状态": string;
  }
}

export enum PageType {
  DASHBOARD = 'DASHBOARD',
  SKU_MASTER = 'SKU_MASTER',
  SUPPLIERS = 'SUPPLIERS',
  QUOTATIONS = 'QUOTATIONS',
  CONTRACTS = 'CONTRACTS',
  AI_ADVISOR = 'AI_ADVISOR'
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  baseId: string;
}
