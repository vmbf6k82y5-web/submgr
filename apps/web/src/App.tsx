import { Link, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { EmptyBlock } from './components/ui';
import { Overview } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { SubscriptionDetail } from './pages/SubscriptionDetail';
import { SubscriptionForm } from './pages/SubscriptionForm';
import { Subscriptions } from './pages/Subscriptions';
import { Trends } from './pages/Trends';

/**
 * 六个页面：
 *   /                       总览
 *   /subscriptions          订阅列表
 *   /subscriptions/new      新增订阅
 *   /subscriptions/:id      订阅详情（版本历史 + 扣款记录）
 *   /subscriptions/:id/edit 编辑订阅（改价走新建版本）
 *   /trends                 趋势
 *   /settings               设置
 */
export function App(): JSX.Element {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/subscriptions/new" element={<SubscriptionForm key="create" mode="create" />} />
        <Route path="/subscriptions/:id" element={<SubscriptionDetail />} />
        <Route path="/subscriptions/:id/edit" element={<SubscriptionForm key="edit" mode="edit" />} />
        <Route path="/trends" element={<Trends />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route
          path="*"
          element={
            <EmptyBlock
              title="页面不存在"
              detail="地址可能输错了"
              action={
                <Link to="/" className="btn-primary">
                  回总览
                </Link>
              }
            />
          }
        />
      </Routes>
    </Layout>
  );
}
