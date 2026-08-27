import React, { useState } from 'react';
import { useAuth } from '../lib/api';
import { EmbeddedPage, Layout } from '../components/ui';
import { CataloguePage } from './Catalogue';
import { SuppliersPage } from './Finance';
import { FleetPage } from './Fleet';
import { CustomersPage, CentresPage } from './Centres';
import { WarehouseMapPage } from './WarehouseMap';

type MasterTab = 'products' | 'suppliers' | 'vehicles' | 'customers' | 'centres' | 'warehouse';

const TAB_ACCESS: Record<MasterTab, string[]> = {
  products: ['master.product.manage', 'master.category.manage'],
  suppliers: ['master.supplier.manage'],
  vehicles: ['master.vehicle.manage'],
  customers: ['master.customer.manage'],
  centres: ['admin.settings.manage', 'centre.performance.view'],
  warehouse: ['master.location.manage'],
};

const TAB_LABELS: Record<MasterTab, string> = {
  products: 'Products & categories',
  suppliers: 'Suppliers',
  vehicles: 'Vehicles & drivers',
  customers: 'Customers',
  centres: 'Centres',
  warehouse: 'Warehouse map',
};

export function MasterDataPage() {
  const { can } = useAuth();
  const visible = (Object.keys(TAB_ACCESS) as MasterTab[])
    .filter((tab) => can(...TAB_ACCESS[tab]));
  const [tab, setTab] = useState<MasterTab>(visible[0] ?? 'products');

  if (!visible.length) {
    return <Layout title="Master data" subtitle="Lists used across the system"> </Layout>;
  }

  const active = visible.includes(tab) ? tab : visible[0];
  return (
    <Layout title="Master data" subtitle="Add, update, and retire the lists used across the system">
      <div className="tabs">
        {visible.map((item) => (
          <button key={item} className={`tab ${active === item ? 'active' : ''}`}
            onClick={() => setTab(item)}>
            {TAB_LABELS[item]}
          </button>
        ))}
      </div>
      {active === 'products' ? <EmbeddedPage><CataloguePage /></EmbeddedPage> : null}
      {active === 'suppliers' ? <EmbeddedPage><SuppliersPage /></EmbeddedPage> : null}
      {active === 'vehicles' ? <EmbeddedPage><FleetPage /></EmbeddedPage> : null}
      {active === 'customers' ? <EmbeddedPage><CustomersPage /></EmbeddedPage> : null}
      {active === 'centres' ? <EmbeddedPage><CentresPage /></EmbeddedPage> : null}
      {active === 'warehouse' ? <EmbeddedPage><WarehouseMapPage /></EmbeddedPage> : null}
    </Layout>
  );
}
