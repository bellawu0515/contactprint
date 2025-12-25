import React, { useState, useEffect } from 'react';
import {
  Menu,
  Bell,
  Search,
  ChevronRight,
  AlertTriangle,
  Package,
  CheckCircle2,
  Clock,
  Bot,
  RefreshCw,
  ExternalLink,
  TrendingDown,
  TrendingUp,
  ShieldCheck,
  User,
  Info
} from 'lucide-react';
import { PageType, SKU, Supplier, Quotation, Contract } from './types';
import { NAVIGATION, FEISHU_CONFIG } from './constants';
import { FeishuService } from './services/feishuService';
import { GeminiService } from './services/geminiService';
import StatCard from './components/StatCard';
import DataTable from './components/DataTable';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

// ✅ 新增：自动表头工具
import { buildAutoColumns, flattenFeishuRecord, type FeishuFieldMeta } from "./utils/feishuColumns";

const App: React.FC = () => {
  const [activePage, setActivePage] = useState<PageType>(PageType.DASHBOARD);
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(false);

  // 数据状态
  const [skus, setSkus] = useState<SKU[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);

  // ✅ 新增：四张表的字段元信息（用于自动生成表头）
  const [skuFieldMetas, setSkuFieldMetas] = useState<FeishuFieldMeta[]>([]);
  const [supplierFieldMetas, setSupplierFieldMetas] = useState<FeishuFieldMeta[]>([]);
  const [quoteFieldMetas, setQuoteFieldMetas] = useState<FeishuFieldMeta[]>([]);
  const [contractFieldMetas, setContractFieldMetas] = useState<FeishuFieldMeta[]>([]);

  // AI 状态
  const [aiInsight, setAiInsight] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    loadAllData();
  }, []);

  const loadAllData = async () => {
    setIsRefreshing(true);
    try {
      // ✅ 同时拉 records + fields
      const [
        skuData,
        supplierData,
        quoteData,
        contractData,
        skuFieldsRes,
        supplierFieldsRes,
        quoteFieldsRes,
        contractFieldsRes,
      ] = await Promise.all([
        FeishuService.fetchTableRecords<SKU>(FEISHU_CONFIG.TABLES.SKU_MASTER),
        FeishuService.fetchTableRecords<Supplier>(FEISHU_CONFIG.TABLES.SUPPLIERS),
        FeishuService.fetchTableRecords<Quotation>(FEISHU_CONFIG.TABLES.QUOTATIONS),
        FeishuService.fetchTableRecords<Contract>(FEISHU_CONFIG.TABLES.CONTRACTS),

        FeishuService.fetchTableFields(FEISHU_CONFIG.TABLES.SKU_MASTER),
        FeishuService.fetchTableFields(FEISHU_CONFIG.TABLES.SUPPLIERS),
        FeishuService.fetchTableFields(FEISHU_CONFIG.TABLES.QUOTATIONS),
        FeishuService.fetchTableFields(FEISHU_CONFIG.TABLES.CONTRACTS),
      ]);

      // 检测是否进入了降级模拟模式（你原逻辑保留）
      const isMock = (skuData.length > 0 && (skuData as any)[0]?.id === '1');
      setIsDemoMode(isMock);

      setSkus(skuData);
      setSuppliers(supplierData);
      setQuotations(quoteData);
      setContracts(contractData);

      // ✅ fields 接口一般返回 { items: [...] }，做一个兼容兜底
      setSkuFieldMetas(((skuFieldsRes as any)?.items || []) as FeishuFieldMeta[]);
      console.log("skuFieldMetas length =", ((skuFieldsRes as any)?.items || []).length, skuFieldsRes);
      setSupplierFieldMetas(((supplierFieldsRes as any)?.items || []) as FeishuFieldMeta[]);
      setQuoteFieldMetas(((quoteFieldsRes as any)?.items || []) as FeishuFieldMeta[]);
      setContractFieldMetas(((contractFieldsRes as any)?.items || []) as FeishuFieldMeta[]);
    } catch (error) {
      console.error("数据同步失败", error);
      setIsDemoMode(true);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  const num = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const handleAIAnalysis = async () => {
    setIsAnalyzing(true);
    setActivePage(PageType.AI_ADVISOR);

    // ⚠️ 这里仍然使用你原来的字段名做风险扫描（如果你飞书字段不同，这里会统计为 0）
    const riskContext = {
      lowStock: skus
        .filter(s => num((s as any)?.fields?.["当前库存"]) < num((s as any)?.fields?.["安全库存"]))
        .map(s => (s as any)?.fields),
      expiringContracts: contracts.filter(c => {
        const dt = (c as any)?.fields?.["到期日期"];
        if (!dt) return false;
        const expiry = new Date(dt).getTime();
        return expiry - Date.now() < 30 * 24 * 60 * 60 * 1000;
      }).map(c => (c as any)?.fields),
      suppliers: suppliers.map(s => (s as any)?.fields)
    };

    const insight = await GeminiService.analyzeSupplyChainData(JSON.stringify(riskContext));
    setAiInsight(insight);
    setIsAnalyzing(false);
  };

  const totalStockValue = skus.reduce((acc, sku) => {
    const skuNo = (sku as any)?.fields?.["SKU编号"];
    const quote = quotations.find(q => (q as any)?.fields?.["SKU编号"] === skuNo);
    const price = num((quote as any)?.fields?.["含税单价"] || (quote as any)?.fields?.["含税价格/台"]);
    return acc + (price * num((sku as any)?.fields?.["当前库存"]));
  }, 0);

  const riskSkusCount = skus.filter(s =>
    num((s as any)?.fields?.["当前库存"]) < num((s as any)?.fields?.["安全库存"])
  ).length;

  const pendingContracts = contracts.filter(c => (c as any)?.fields?.["合同状态"] !== '履行中').length;

  const chartData = skus.slice(0, 8).map(s => ({
    name: (s as any)?.fields?.["品名"] || (s as any)?.fields?.["产品名称"] || '未知',
    "当前": num((s as any)?.fields?.["当前库存"]),
    "安全水位": num((s as any)?.fields?.["安全库存"])
  }));

  const renderContent = () => {
    switch (activePage) {
      case PageType.DASHBOARD:
        return (
          <div className="space-y-6">
            {isDemoMode && (
              <div className="bg-amber-50 border border-amber-200 p-4 rounded-2xl flex items-center gap-3 text-amber-800 shadow-sm animate-pulse">
                <Info size={20} className="text-amber-500 shrink-0" />
                <div className="text-sm">
                  <span className="font-bold">演示数据模式：</span> 由于浏览器 CORS 跨域限制，无法直接连接飞书服务器。生产环境需配置后端中转。
                </div>
              </div>
            )}
            <div className="flex justify-between items-end">
              <div>
                <h1 className="text-2xl font-bold text-slate-800">供应链决策看板</h1>
                <p className="text-slate-500 text-sm mt-1">数据源：飞书多维表格 (ID: {FEISHU_CONFIG.BASE_ID.slice(0,8)}...)</p>
              </div>
              <button
                onClick={loadAllData}
                className="flex items-center gap-2 text-indigo-600 bg-indigo-50 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-100 transition-colors"
              >
                <RefreshCw size={16} className={isRefreshing ? 'animate-spin' : ''} />
                同步最新数据
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <StatCard
                title="资产总额 (库存估值)"
                value={`¥${(totalStockValue / 10000).toFixed(2)}w`}
                icon={<Package className="text-indigo-600" />}
                colorClass="bg-indigo-50"
                trend={{ value: 4.2, isUp: true }}
              />
              <StatCard
                title="库存预警 SKU"
                value={riskSkusCount}
                subValue="需立即补货"
                icon={<AlertTriangle className="text-rose-600" />}
                colorClass="bg-rose-50"
              />
              <StatCard
                title="活跃供应商"
                value={suppliers.filter(s => (s as any)?.fields?.["状态"] === '合作中').length}
                subValue={`总计 ${suppliers.length} 家`}
                icon={<ShieldCheck className="text-emerald-600" />}
                colorClass="bg-emerald-50"
              />
              <StatCard
                title="待续约/异常合同"
                value={pendingContracts}
                icon={<Clock className="text-amber-600" />}
                colorClass="bg-amber-50"
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                <div className="flex justify-between items-center mb-8">
                  <h3 className="font-bold text-slate-800">关键物料库存监控</h3>
                  <div className="flex gap-4 text-xs">
                    <span className="flex items-center gap-1"><div className="w-3 h-3 bg-indigo-600 rounded"></div> 当前库存</span>
                    <span className="flex items-center gap-1"><div className="w-3 h-3 bg-rose-400 rounded"></div> 安全线</span>
                  </div>
                </div>
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} />
                      <YAxis axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} />
                      <Tooltip
                        cursor={{fill: '#f8fafc'}}
                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                      />
                      <Bar dataKey="当前" fill="#4f46e5" radius={[6, 6, 0, 0]} barSize={40}>
                         {chartData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.当前 < entry.安全水位 ? '#fb7185' : '#4f46e5'} />
                         ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="flex flex-col gap-6">
                <div className="bg-gradient-to-br from-indigo-600 to-violet-700 p-6 rounded-2xl text-white shadow-lg shadow-indigo-200">
                   <div className="flex items-center gap-3 mb-4">
                      <div className="p-2 bg-white/20 rounded-lg">
                        <Bot size={24} />
                      </div>
                      <span className="font-bold">AI 决策助手</span>
                   </div>
                   <p className="text-indigo-100 text-sm leading-relaxed mb-6">
                     正在实时监控飞书多维表格。Gemini 已发现 {riskSkusCount} 项潜在缺货风险。
                   </p>
                   <button
                    onClick={handleAIAnalysis}
                    className="w-full bg-white text-indigo-600 py-3 rounded-xl font-bold text-sm hover:bg-indigo-50 transition-all flex items-center justify-center gap-2"
                   >
                     查看风险分析报告 <ChevronRight size={16} />
                   </button>
                </div>

                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex-1">
                  <h3 className="font-bold text-slate-800 mb-4 text-sm">最近合同提醒</h3>
                  <div className="space-y-4">
                    {contracts.slice(0, 3).map((c, i) => (
                      <div key={i} className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl hover:bg-indigo-50 transition-colors group">
                        <div className="p-2 bg-white rounded-lg text-slate-400 group-hover:text-indigo-600 shadow-sm">
                          <CheckCircle2 size={16} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-slate-900 truncate">{(c as any)?.fields?.["合同名称"]}</p>
                          <p className="text-[10px] text-slate-500 mt-0.5">到期：{(c as any)?.fields?.["到期日期"]}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );

      case PageType.SKU_MASTER:
        return (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-slate-800">SKU 主档数据</h2>
              <a
                href={`https://ai.feishu.cn/base/${FEISHU_CONFIG.BASE_ID}?table=${FEISHU_CONFIG.TABLES.SKU_MASTER}`}
                target="_blank"
                className="text-xs flex items-center gap-1 text-slate-400 hover:text-indigo-600"
                rel="noreferrer"
              >
                在飞书查看原表 <ExternalLink size={12} />
              </a>
            </div>

            {/* ✅ 自动字段表头：优先字段 + 其余字段 */}
            {(() => {
              const skuRows = (skus as any[]).map(flattenFeishuRecord);
              const skuColumns = buildAutoColumns({
                fieldMetas: skuFieldMetas,
                priorityKeys: [
                  "图", "SKU编号", "品名", "规格", "分类", "当前库存", "安全库存", "单位", "状态", "生产部门", "颜色", "单个产品包装尺寸"
                ],
                maxColumns: 28,
              });

              return (
                <DataTable
                  isLoading={isLoading}
                  data={skuRows}
                  columns={skuColumns}
                />
              );
            })()}
          </div>
        );

      case PageType.AI_ADVISOR:
        return (
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100">
               <div className="bg-indigo-600 px-8 py-10 text-white relative">
                  <div className="relative z-10">
                    <div className="inline-flex items-center gap-2 bg-white/20 px-3 py-1 rounded-full text-xs font-bold mb-4 backdrop-blur-sm">
                      <Bot size={14} /> AI 深度扫描报告
                    </div>
                    <h2 className="text-3xl font-black italic">Gemini SCM Insight</h2>
                    <p className="mt-2 text-indigo-100 text-sm">基于实时表格数据的供应链风险评估报告</p>
                  </div>
                  <Bot className="absolute -right-10 -bottom-10 text-white/10" size={240} />
               </div>

               <div className="p-8">
                  {isAnalyzing ? (
                    <div className="py-20 flex flex-col items-center justify-center space-y-4">
                      <div className="relative w-16 h-16">
                        <div className="absolute inset-0 border-4 border-indigo-100 rounded-full"></div>
                        <div className="absolute inset-0 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                      </div>
                      <p className="text-slate-400 font-medium animate-pulse">正在利用 Gemini 3.0 处理海量 SKU 数据...</p>
                    </div>
                  ) : (
                    <div className="prose prose-indigo max-w-none">
                       {aiInsight ? (
                         <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200 leading-relaxed text-slate-700"
                              dangerouslySetInnerHTML={{ __html: aiInsight.replace(/\n/g, '<br/>') }} />
                       ) : (
                         <div className="text-center py-20 text-slate-300">
                           点击首页“开始智能分析”按钮生成报告
                         </div>
                       )}
                    </div>
                  )}
               </div>
            </div>
          </div>
        );

      default:
        return (
          <div className="flex flex-col items-center justify-center py-20 bg-white rounded-3xl border border-dashed border-slate-300">
            <Package size={48} className="text-slate-200 mb-4" />
            <h3 className="text-slate-400 font-medium">此模块（{activePage}）暂未在多维表格中配置视图</h3>
          </div>
        );
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 font-sans">
      <aside className={`bg-white border-r border-slate-200 transition-all duration-300 ${isSidebarOpen ? 'w-72' : 'w-20'} flex flex-col z-20`}>
        <div className="p-8 flex items-center gap-4">
          <div className="min-w-[40px] h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-100">
            <RefreshCw size={20} className={isRefreshing ? 'animate-spin' : ''} />
          </div>
          {isSidebarOpen && (
            <div className="flex flex-col">
              <span className="font-black text-lg tracking-tight text-slate-900 leading-none">智链看板</span>
              <span className="text-[10px] text-slate-400 uppercase tracking-widest mt-1">Feishu Bitable v1.0</span>
            </div>
          )}
        </div>

        <nav className="flex-1 px-4 py-4 space-y-1.5">
          <div className="px-4 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
            {isSidebarOpen ? '核心业务模块' : '···'}
          </div>
          {NAVIGATION.map((item) => (
            <button
              key={item.id}
              onClick={() => setActivePage(item.id as PageType)}
              className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all group ${
                activePage === item.id
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-100 font-bold scale-[1.02]'
                  : 'text-slate-500 hover:bg-indigo-50 hover:text-indigo-600'
              }`}
            >
              <span className={`transition-colors ${activePage === item.id ? 'text-white' : 'text-slate-400 group-hover:text-indigo-600'}`}>
                {item.icon}
              </span>
              {isSidebarOpen && <span className="truncate flex-1 text-left">{item.name}</span>}
              {activePage === item.id && isSidebarOpen && <div className="w-1.5 h-1.5 bg-white rounded-full"></div>}
            </button>
          ))}
        </nav>

        <div className="p-6 border-t border-slate-50 bg-slate-50/50">
          <div className={`flex items-center gap-3 p-3 rounded-2xl hover:bg-white cursor-pointer transition-all border border-transparent hover:border-slate-100 ${!isSidebarOpen && 'justify-center'}`}>
             <div className="w-10 h-10 rounded-full border-2 border-white shadow-sm overflow-hidden bg-indigo-100 flex items-center justify-center">
                <User size={20} className="text-indigo-600" />
             </div>
             {isSidebarOpen && (
               <div className="flex-1 min-w-0">
                 <p className="text-sm font-bold text-slate-900 truncate">管理员</p>
                 <p className="text-[10px] text-slate-400 truncate">SCM 决策中心</p>
               </div>
             )}
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <header className="bg-white/80 backdrop-blur-xl border-b border-slate-200 h-20 flex items-center justify-between px-10 sticky top-0 z-10">
          <div className="flex items-center gap-6">
            <button
              onClick={() => setSidebarOpen(!isSidebarOpen)}
              className="p-2.5 text-slate-400 hover:bg-slate-100 rounded-xl transition-colors border border-slate-100"
            >
              <Menu size={20} />
            </button>
            <div className="hidden md:flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl text-slate-400 border border-slate-100 focus-within:border-indigo-300 focus-within:bg-white transition-all w-80">
              <Search size={18} />
              <input type="text" placeholder="搜索..." className="bg-transparent text-sm outline-none w-full" />
            </div>
          </div>

          <div className="flex items-center gap-4">
             <div className="hidden lg:flex flex-col items-end mr-4">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">API STATUS</span>
                <span className={`flex items-center gap-1.5 font-bold text-[10px] ${isDemoMode ? 'text-amber-500' : 'text-emerald-500'}`}>
                   <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${isDemoMode ? 'bg-amber-500' : 'bg-emerald-500'}`}></div>
                   {isDemoMode ? 'DEMO MODE' : 'FEISHU CONNECTED'}
                </span>
             </div>
             <button className="p-2.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 rounded-xl relative transition-all border border-slate-100">
                <Bell size={20} />
                <span className="absolute top-2.5 right-2.5 w-2 h-2 bg-rose-500 rounded-full border-2 border-white shadow-sm"></span>
             </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-10 custom-scrollbar">
          <div className="max-w-7xl mx-auto">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-40 space-y-6">
                <div className="relative w-20 h-20">
                  <div className="absolute inset-0 border-8 border-indigo-100 rounded-3xl"></div>
                  <div className="absolute inset-0 border-8 border-indigo-600 border-t-transparent rounded-3xl animate-spin"></div>
                </div>
                <div className="text-center">
                  <p className="text-slate-800 font-black text-xl mb-1">正在同步飞书数据...</p>
                </div>
              </div>
            ) : renderContent()}
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
