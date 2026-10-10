/**
 * ECharts 包装：按需注册（只用柱状图 + 网格/提示/图例 + Canvas 渲染器），
 * 不引入完整包，避免为了一个堆叠柱状图多打包几百 KB。
 */

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

echarts.use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export function EChart({
  option,
  height = 320,
  ariaLabel,
}: {
  option: EChartsOption;
  height?: number;
  ariaLabel?: string;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const chart = echarts.init(element);
    chartRef.current = chart;

    // 手机旋转 / 侧栏折叠都要跟着变宽高
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={containerRef} style={{ height }} role="img" aria-label={ariaLabel} />;
}
