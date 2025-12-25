
import React from 'react';

interface StatCardProps {
  title: string;
  value: string | number;
  subValue?: string;
  icon: React.ReactNode;
  trend?: {
    value: number;
    isUp: boolean;
  };
  colorClass: string;
}

const StatCard: React.FC<StatCardProps> = ({ title, value, subValue, icon, trend, colorClass }) => {
  return (
    <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-100 transition-all hover:shadow-md">
      <div className="flex justify-between items-start mb-4">
        <div className={`p-3 rounded-lg ${colorClass}`}>
          {icon}
        </div>
        {trend && (
          <span className={`text-xs font-medium px-2 py-1 rounded-full ${trend.isUp ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
            {trend.isUp ? '+' : '-'}{trend.value}%
          </span>
        )}
      </div>
      <div>
        <h3 className="text-sm font-medium text-slate-500 mb-1">{title}</h3>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-slate-900">{value}</span>
          {subValue && <span className="text-xs text-slate-400">{subValue}</span>}
        </div>
      </div>
    </div>
  );
};

export default StatCard;
