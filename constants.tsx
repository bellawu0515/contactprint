
import React from 'react';
import { 
  LayoutDashboard, 
  Package, 
  Users, 
  FileText, 
  BarChart3, 
  Bot 
} from 'lucide-react';

export const FEISHU_CONFIG = {
  // ⚠️ 安全说明：APP_SECRET 绝对不要放在前端代码里（会被任何人看到）。
  // 这里仅保留 Base / Table ID（非敏感），用于跳转到飞书原表。
  BASE_ID: 'ZaD2bRzlJacxlOsicb7c5huanaf',
  TABLES: {
    SKU_MASTER: 'tblUnB3HITbxCIrL',
    QUOTATIONS: 'tblf1NwgVlWcqgCg',
    SUPPLIERS: 'tblIUEU9iTL40KNg',
    CONTRACTS: 'tblRkVjVCBxc1T7c'
  }
};

export const NAVIGATION = [
  { id: 'DASHBOARD', name: '总览看板', icon: <LayoutDashboard size={20} /> },
  { id: 'SKU_MASTER', name: 'SKU主档', icon: <Package size={20} /> },
  { id: 'SUPPLIERS', name: '供应商库', icon: <Users size={20} /> },
  { id: 'QUOTATIONS', name: '报价库', icon: <BarChart3 size={20} /> },
  { id: 'CONTRACTS', name: '合同台账', icon: <FileText size={20} /> },
  { id: 'AI_ADVISOR', name: 'AI 供应链助手', icon: <Bot size={20} /> },
];
