// @vitest-environment jsdom
/**
 * 页面级冒烟测试：在 jsdom 里真的把页面渲染一遍。
 *
 * 为什么值得单独写：需求要求「/api 调不通先接 mock 数据保证页面可渲染」，
 * 只测纯函数证明不了「页面能渲染」。这里用示例数据模式跑通六个页面，
 * 顺便锁住两个关键交互：
 *   * 总览页会显示汇率异常提示；
 *   * 编辑页改价格时会提示「将新增价格版本」。
 *
 * ECharts 在 jsdom 里没有 canvas，所以趋势图组件用桩替换（图表配置另有单测）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import { resetConn, setConn } from './lib/conn';
import { resetMockState } from './lib/mock/data';
import { resetSource } from './lib/source';

vi.mock('./components/EChart', () => ({
  EChart: ({ ariaLabel }: { ariaLabel?: string }) => <div data-testid="echart">{ariaLabel}</div>,
}));

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetConn();
  resetMockState();
  resetSource();
  // 没配置令牌 -> auto 模式会用内置示例数据，正好是「调不通也能渲染」的路径
  setConn({ mode: 'auto', token: '' });
});

afterEach(() => {
  cleanup();
});

describe('页面冒烟（示例数据模式）', () => {
  it('总览：三种状态分开统计 + 月均/年均/未来 30 天 + 示例数据横幅', async () => {
    renderAt('/');

    await waitFor(() => expect(screen.getByText('月均支出')).toBeTruthy());
    expect(screen.getByText('年均支出')).toBeTruthy();
    expect(screen.getAllByText(/未来 30 天/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('三种状态分开统计')).toBeTruthy();
    expect(screen.getByText('正常')).toBeTruthy();
    expect(screen.getByText('异常')).toBeTruthy();
    expect(screen.getByText('已结束')).toBeTruthy();
    // 示例数据必须显眼提示，不能让假数据冒充真账本
    expect(screen.getByText('示例数据')).toBeTruthy();
    // 异常订阅的意义说明来自 core
    expect(screen.getByText(/试用已于 .* 到期/)).toBeTruthy();
  });

  it('总览：缺币种汇率时给明确提示，合计显示为「—」', async () => {
    setConn({ mode: 'mock', mockScenario: 'missing' });
    renderAt('/');

    await waitFor(() => expect(screen.getByText(/缺少 JPY 的汇率/)).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('总览：汇率过期时给提示', async () => {
    setConn({ mode: 'mock', mockScenario: 'stale' });
    renderAt('/');
    await waitFor(() => expect(screen.getByText(/汇率数据已过期/)).toBeTruthy());
  });

  it('订阅列表：渲染订阅、异常标红、可按状态筛选', async () => {
    renderAt('/subscriptions');

    await waitFor(() => expect(screen.getByText('爱奇艺黄金会员')).toBeTruthy());
    expect(screen.getByText('Netflix 高级会员')).toBeTruthy();
    expect(screen.getByText(/共 7 个/)).toBeTruthy();

    // 异常订阅的说明用红色文本渲染出来
    const anomalyReason = screen.getByText(/试用已于 .* 到期/);
    expect(anomalyReason.className).toContain('text-red');

    fireEvent.change(screen.getByLabelText('按状态筛选'), { target: { value: 'ended' } });
    await waitFor(() => expect(screen.queryByText('爱奇艺黄金会员')).toBeNull());
    expect(screen.getByText('Spotify 家庭版')).toBeTruthy();
  });

  it('订阅详情：渲染版本历史与扣款记录，并展示冻结/退款状态', async () => {
    renderAt('/subscriptions/sub-iqiyi');

    await waitFor(() => expect(screen.getByText('版本历史（2）')).toBeTruthy());
    expect(screen.getByText(/扣款记录（\d+）/)).toBeTruthy();
    // 涨价前后的两个版本都在
    expect(screen.getAllByText('已生效 · 冻结').length).toBeGreaterThanOrEqual(1);
  });

  it('编辑页：改价格时引导用户新建版本（不直接改已生效版本）', async () => {
    renderAt('/subscriptions/sub-iqiyi/edit');

    await waitFor(() => expect(screen.getByText('当前生效版本（已冻结）')).toBeTruthy());
    expect(screen.getByText('调整价格')).toBeTruthy();

    const amountInput = screen.getByPlaceholderText('25.00');
    fireEvent.change(amountInput, { target: { value: '35.00' } });

    await waitFor(() => expect(screen.getByText('改动会新建一个价格版本')).toBeTruthy());
    expect(screen.getByText(/新增一个价格版本/)).toBeTruthy();
    expect(screen.getByText('新增价格版本')).toBeTruthy();
  });

  it('新增页：能填表并提交（示例数据模式下会真的建出一个订阅）', async () => {
    renderAt('/subscriptions/new');

    await waitFor(() => expect(screen.getByText('首个价格版本')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('例如：Netflix 高级会员'), {
      target: { value: '冒烟测试订阅' },
    });
    fireEvent.change(screen.getByPlaceholderText('25.00'), { target: { value: '12.50' } });
    fireEvent.click(screen.getByText('保存订阅'));

    // 提交成功后跳到详情页
    await waitFor(() => expect(screen.getByText('冒烟测试订阅')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText('版本历史（1）')).toBeTruthy();
  });

  it('趋势：四个维度可切换，图表容器出现', async () => {
    renderAt('/trends');

    await waitFor(() => expect(screen.getByTestId('echart')).toBeTruthy());
    for (const label of ['分类', '付费周期', '扣费渠道', '订阅类型']) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    fireEvent.click(screen.getByText('近 6 个月'));
    await waitFor(() => expect(screen.getByText(/只统计实际发生的扣款/)).toBeTruthy());
  });

  it('设置：展示账本设置、ICS 地址、提醒渠道与本地连接', async () => {
    renderAt('/settings');

    await waitFor(() => expect(screen.getByText('账本设置')).toBeTruthy());
    expect(screen.getByText('日历订阅（ICS）')).toBeTruthy();
    expect(screen.getByText('飞书 · 主号')).toBeTruthy();
    expect(screen.getByText('Telegram · 备用')).toBeTruthy();
    expect(screen.getByText('本地连接（只存在这台设备上）')).toBeTruthy();

    const icsInput = screen.getByDisplayValue(/\/ics\/.*\.ics$/) as HTMLInputElement;
    expect(icsInput.value).toContain('/ics/');
  });

  it('未知路径回落到「页面不存在」', async () => {
    renderAt('/nope');
    await waitFor(() => expect(screen.getByText('页面不存在')).toBeTruthy());
  });
});
