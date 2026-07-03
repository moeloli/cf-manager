<template>
  <div>
    <n-space justify="space-between" align="center">
      <n-h2>账号管理</n-h2>
      <n-button type="primary" @click="showAddModal = true">添加账号</n-button>
    </n-space>

    <n-data-table
      :columns="columns"
      :data="accountStore.accounts"
      :loading="accountStore.loading"
      :bordered="false"
      :scroll-x="700"
    />

    <n-modal v-model:show="showAddModal" preset="dialog" title="添加账号" style="width: 500px; max-width: 95vw">
      <n-form :model="form" label-placement="left" label-width="100">
        <n-form-item label="名称">
          <n-input v-model:value="form.name" placeholder="账号名称" />
        </n-form-item>
        <n-form-item label="认证类型">
          <n-select v-model:value="form.auth_type" :options="authTypeOptions" />
        </n-form-item>
        <n-form-item v-if="form.auth_type === 'token'" label="API Token">
          <n-input v-model:value="form.api_token" type="password" show-password-on="click" placeholder="Cloudflare API Token" />
        </n-form-item>
        <n-form-item v-if="form.auth_type === 'global_key'" label="API Key">
          <n-input v-model:value="form.api_key" type="password" show-password-on="click" placeholder="Cloudflare API Key" />
        </n-form-item>
        <n-form-item v-if="form.auth_type === 'global_key'" label="Email">
          <n-input v-model:value="form.email" placeholder="Cloudflare 账号邮箱" />
        </n-form-item>
        <n-form-item label="启用功能">
          <n-checkbox-group v-model:value="form.features">
            <n-space>
              <n-checkbox v-for="f in featureOptions" :key="f.value" :value="f.value" :label="f.label" />
            </n-space>
          </n-checkbox-group>
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showAddModal = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="handleAdd">提交</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showFeatureModal" preset="dialog" title="编辑功能开关" style="width: 400px; max-width: 95vw">
      <n-checkbox-group v-model:value="editFeatures">
        <n-space vertical>
          <n-checkbox v-for="f in featureOptions" :key="f.value" :value="f.value" :label="f.label" />
        </n-space>
      </n-checkbox-group>
      <template #action>
        <n-button @click="showFeatureModal = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="handleSaveFeatures">保存</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, onMounted } from 'vue';
import { NButton, NSpace, NTag, useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { useAccountStore } from '../stores/accountStore';

const accountStore = useAccountStore();
const message = useMessage();
const showAddModal = ref(false);
const showFeatureModal = ref(false);
const submitting = ref(false);
const editingAccountId = ref<number | null>(null);
const editFeatures = ref<string[]>([]);

const featureOptions = [
  { label: 'Workers AI', value: 'ai' },
  { label: 'Workers / Pages', value: 'workers' },
  { label: '浏览器渲染', value: 'browser_render' },
  { label: 'DNS 管理', value: 'dns' },
  { label: '存储管理', value: 'storage' },
];

const featureLabelMap: Record<string, string> = {
  ai: 'AI',
  workers: 'Workers',
  browser_render: '浏览器',
  dns: 'DNS',
  storage: '存储',
};

const form = ref({
  name: '',
  auth_type: 'token',
  api_token: '',
  api_key: '',
  email: '',
  features: ['ai', 'workers', 'browser_render', 'dns', 'storage'] as string[],
});

const authTypeOptions = [
  { label: 'API Token', value: 'token' },
  { label: 'API Key + Email', value: 'global_key' },
];

function resetForm() {
  form.value = { name: '', auth_type: 'token', api_token: '', api_key: '', email: '', features: ['ai', 'workers', 'browser_render', 'dns', 'storage'] };
}

async function handleAdd() {
  if (!form.value.name) {
    message.warning('请输入账号名称');
    return;
  }
  submitting.value = true;
  try {
    const { features, ...rest } = form.value;
    await accountStore.createAccount({ ...rest, enabled_features: features.join(',') });
    message.success('账号添加成功');
    showAddModal.value = false;
    resetForm();
  } finally {
    submitting.value = false;
  }
}

function openFeatureEditor(row: any) {
  editingAccountId.value = row.id;
  const raw = row.enabled_features || 'ai,workers,browser_render,dns,storage';
  editFeatures.value = raw.split(',').filter(Boolean);
  showFeatureModal.value = true;
}

async function handleSaveFeatures() {
  if (editingAccountId.value == null) return;
  submitting.value = true;
  try {
    await accountStore.updateFeatures(editingAccountId.value, editFeatures.value.join(','));
    message.success('功能开关已更新');
    showFeatureModal.value = false;
  } finally {
    submitting.value = false;
  }
}

async function handleTest(row: any) {
  await accountStore.testAccount(row.id);
  message.success('连接测试成功');
}

async function handleDelete(row: any) {
  await accountStore.deleteAccount(row.id);
  message.success('已删除');
}

function parseFeatures(raw: string | undefined): string[] {
  return (raw || 'ai,workers,browser_render,dns,storage').split(',').filter(Boolean);
}

const columns: DataTableColumns<any> = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '名称', key: 'name', width: 150 },
  { title: 'Account ID', key: 'account_id', width: 180, ellipsis: { tooltip: true }, render: (row) => row.account_id || '-' },
  { title: '认证类型', key: 'auth_type', width: 120, render: (row) => h(NTag, { size: 'small', type: row.auth_type === 'token' ? 'info' : 'warning' }, { default: () => row.auth_type === 'token' ? 'Token' : 'Key' }) },
  {
    title: '功能', key: 'enabled_features', width: 200,
    render: (row) => {
      const features = parseFeatures(row.enabled_features);
      return h(NSpace, { size: 4 }, {
        default: () => features.map(f =>
          h(NTag, { size: 'small', type: 'success', bordered: false }, { default: () => featureLabelMap[f] || f })
        ),
      });
    },
  },
  { title: '状态', key: 'is_active', width: 80, render: (row) => h(NTag, { size: 'small', type: row.is_active ? 'success' : 'default' }, { default: () => row.is_active ? '活跃' : '未验证' }) },
  {
    title: '操作', key: 'actions', width: 220,
    render: (row) => h(NSpace, { size: 4 }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => openFeatureEditor(row) }, { default: () => '功能' }),
        h(NButton, { size: 'small', onClick: () => handleTest(row) }, { default: () => '测试' }),
        h(NButton, { size: 'small', type: 'error', onClick: () => handleDelete(row) }, { default: () => '删除' }),
      ],
    }),
  },
];

onMounted(() => {
  accountStore.fetchAccounts();
});
</script>
