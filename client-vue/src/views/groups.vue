<template>
  <div class="groups-page h-screen flex flex-col">
    <div
      class="groups-shell flex-1 overflow-hidden flex flex-col max-w-7xl mx-auto w-full p-3 sm:p-6"
    >
      <!-- 页面头部 -->
      <div
        class="groups-page-header flex flex-wrap items-center justify-between gap-3 mb-4 sm:mb-6 flex-shrink-0"
      >
        <div>
          <h1 class="groups-page-title text-xl sm:text-2xl font-bold">群组管理</h1>
          <p class="groups-page-description mt-1">高效管理您创建及加入的全部协作群组</p>
        </div>
        <div class="groups-page-actions flex flex-wrap gap-2 sm:gap-3">
          <n-button
            class="back-button"
            @click="goBack"
            secondary
          >
            <template #icon>
              <i
                class="iconfont icon-arrow-left"
                aria-hidden="true"
              ></i>
            </template>
            返回
          </n-button>
          <n-button
            class="create-group-button"
            type="primary"
            @click="showCreateModal = true"
          >
            <template #icon>
              <i
                class="iconfont icon-plus"
                aria-hidden="true"
              ></i>
            </template>
            创建群组
          </n-button>
        </div>
      </div>

      <!-- 群组列表 - 添加滚动容器 -->
      <div class="flex-1 overflow-hidden">
        <n-scrollbar style="max-height: 100%">
          <n-spin :show="loading">
            <div class="group-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              <n-card
                v-for="group in groups"
                :key="group.id"
                hoverable
                class="group-card cursor-pointer transition-all"
                @click="handleGroupClick(group)"
              >
                <div class="group-card-main flex items-start gap-4">
                  <n-avatar
                    :size="48"
                    :src="group.avatar || undefined"
                    class="group-avatar flex-shrink-0"
                  >
                    <span v-if="!group.avatar">{{ group.name.charAt(0) }}</span>
                    <template #fallback>
                      <span class="flex h-full w-full items-center justify-center">
                        {{ group.name.charAt(0) }}
                      </span>
                    </template>
                  </n-avatar>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <h3 class="group-card-title font-bold text-lg truncate">{{ group.name }}</h3>
                      <n-badge
                        :value="unread.groupCounts[group.id] || 0"
                        :max="99"
                        :show="!!unread.groupCounts[group.id]"
                      />
                      <n-tag
                        v-if="group.role === 'owner'"
                        type="warning"
                        size="small"
                      >
                        群主
                      </n-tag>
                      <n-tag
                        v-else-if="group.role === 'admin'"
                        type="info"
                        size="small"
                      >
                        管理员
                      </n-tag>
                      <n-tag
                        v-else
                        size="small"
                      >
                        成员
                      </n-tag>
                    </div>
                    <div class="group-card-meta text-xs mt-1">
                      <i
                        class="iconfont regular icon-user mr-1"
                        aria-hidden="true"
                      ></i>
                      {{ group.memberCount }} 位成员
                    </div>
                  </div>
                  <n-dropdown
                    v-if="group.role === 'owner' || group.role === 'admin'"
                    trigger="click"
                    :options="getGroupOptions(group)"
                    @select="(key: string | number) => handleGroupAction(String(key), group)"
                  >
                    <button
                      aria-label="更多群组操作"
                      class="p-1.5 text-slate-400"
                      @click.stop
                    >
                      <i
                        class="iconfont icon-more"
                        aria-hidden="true"
                      ></i>
                    </button>
                  </n-dropdown>
                </div>
                <p class="group-card-description">
                  {{ group.description || '暂无简介，点击可编辑添加团队协作与讨论说明...' }}
                </p>
                <template #action>
                  <div
                    class="group-card-actions flex flex-wrap gap-2"
                    :class="
                      group.role === 'owner' || group.role === 'admin'
                        ? 'group-card-actions--four'
                        : 'group-card-actions--three'
                    "
                  >
                    <n-button
                      size="small"
                      secondary
                      aria-label="聊天"
                      @click.stop="handleChatClick(group)"
                    >
                      <i
                        class="iconfont icon-message sm:mr-1"
                        aria-hidden="true"
                      ></i>
                      <span class="hidden sm:inline">聊天</span>
                    </n-button>
                    <n-button
                      size="small"
                      secondary
                      aria-label="视频"
                      @click.stop="handleVideoCall(group)"
                    >
                      <i
                        class="iconfont icon-video sm:mr-1"
                        aria-hidden="true"
                      ></i>
                      <span class="hidden sm:inline">
                        {{ groupSessionState.getSession(group.id, 'video') ? '加入视频' : '视频' }}
                      </span>
                    </n-button>
                    <n-button
                      size="small"
                      secondary
                      aria-label="共享"
                      @click.stop="handleScreenShare(group)"
                    >
                      <i
                        class="iconfont icon-gongxiangpingmu sm:mr-1"
                        aria-hidden="true"
                      ></i>
                      <span class="hidden sm:inline">
                        {{ groupSessionState.getSession(group.id, 'screen') ? '加入共享' : '共享' }}
                      </span>
                    </n-button>
                    <n-dropdown
                      v-if="group.role === 'owner' || group.role === 'admin'"
                      trigger="click"
                      :options="getGroupOptions(group)"
                      @select="(key: string | number) => handleGroupAction(String(key), group)"
                    >
                      <n-button
                        size="small"
                        secondary
                        aria-label="管理"
                        @click.stop
                      >
                        <i
                          class="iconfont icon-gear sm:mr-1"
                          aria-hidden="true"
                        ></i>
                        <span class="hidden sm:inline">管理</span>
                      </n-button>
                    </n-dropdown>
                  </div>
                </template>
              </n-card>

              <!-- 空状态 -->
              <n-empty
                v-if="!loading && groups.length === 0"
                class="col-span-full py-20"
                description="暂无群组"
              >
                <template #extra>
                  <n-button
                    type="primary"
                    @click="showCreateModal = true"
                  >
                    创建第一个群组
                  </n-button>
                </template>
              </n-empty>
            </div>
          </n-spin>
        </n-scrollbar>
      </div>

      <!-- 创建群组弹窗 -->
      <n-modal
        v-model:show="showCreateModal"
        preset="card"
        class="group-form-modal"
        title="创建群组"
        style="width: 448px; max-width: calc(100vw - 24px)"
      >
        <n-form
          ref="createFormRef"
          :model="createForm"
          :rules="createRules"
        >
          <n-form-item path="name">
            <template #label>
              <span class="form-label-count">
                群组名称
                <span class="text-red-500">*</span>
                <span>{{ createForm.name.length }} / 50</span>
              </span>
            </template>
            <n-input
              v-model:value="createForm.name"
              placeholder="请输入群组名称"
              maxlength="50"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <span class="form-label-count">
                群组简介
                <span>{{ createForm.description.length }} / 200</span>
              </span>
            </template>
            <n-input
              v-model:value="createForm.description"
              type="textarea"
              placeholder="介绍一下您的群组，方便成员了解协作内容..."
              :rows="3"
              maxlength="200"
            />
          </n-form-item>
        </n-form>
        <template #footer>
          <div class="flex justify-end gap-3">
            <n-button @click="showCreateModal = false">取消</n-button>
            <n-button
              type="primary"
              :loading="createLoading"
              @click="handleCreate"
            >
              立即创建
            </n-button>
          </div>
        </template>
      </n-modal>

      <!-- 群组详情弹窗 -->
      <n-modal
        v-model:show="showDetailModal"
        preset="card"
        class="group-detail-modal"
        :title="currentGroup?.name"
        style="width: 512px; max-width: calc(100vw - 24px)"
      >
        <n-spin :show="detailLoading">
          <n-tabs
            type="line"
            animated
          >
            <!-- 群组信息 -->
            <n-tab-pane
              name="info"
              tab="群组信息"
            >
              <div class="group-info-panel space-y-4">
                <div class="group-detail-summary flex items-center gap-4">
                  <n-avatar
                    :size="80"
                    :src="groupDetail?.group.avatar || undefined"
                  >
                    <span v-if="!groupDetail?.group.avatar">
                      {{ groupDetail?.group.name.charAt(0) }}
                    </span>
                    <template #fallback>
                      <span class="flex h-full w-full items-center justify-center">
                        {{ groupDetail?.group.name.charAt(0) }}
                      </span>
                    </template>
                  </n-avatar>
                  <div>
                    <h3 class="text-xl font-bold">{{ groupDetail?.group.name }}</h3>
                    <p class="text-sm text-gray-500 mt-1">{{ groupDetail?.group.description }}</p>
                  </div>
                </div>
                <n-divider />
                <div class="space-y-2">
                  <p>
                    <span class="text-gray-500">群组ID：</span>
                    {{ groupDetail?.group.id }}
                  </p>
                  <p>
                    <span class="text-gray-500">成员数量：</span>
                    {{ groupDetail?.members.length }}
                  </p>
                  <p>
                    <span class="text-gray-500">我的角色：</span>
                    <n-tag
                      v-if="groupDetail?.myRole === 'owner'"
                      type="warning"
                      size="small"
                    >
                      群主
                    </n-tag>
                    <n-tag
                      v-else-if="groupDetail?.myRole === 'admin'"
                      type="info"
                      size="small"
                    >
                      管理员
                    </n-tag>
                    <n-tag
                      v-else
                      size="small"
                    >
                      成员
                    </n-tag>
                  </p>
                </div>
              </div>
            </n-tab-pane>

            <!-- 成员列表 -->
            <n-tab-pane
              name="members"
              :tab="`成员管理 (${groupDetail?.members.length || 0})`"
            >
              <div class="member-management space-y-3">
                <div
                  v-if="groupDetail?.myRole === 'owner' || groupDetail?.myRole === 'admin'"
                  class="member-management-header mb-4"
                >
                  <span class="text-xs font-semibold text-slate-500">小组成员列表</span>
                  <n-button
                    type="primary"
                    size="small"
                    @click="showInviteModal = true"
                  >
                    <template #icon>
                      <i
                        class="iconfont icon-user-plus"
                        aria-hidden="true"
                      ></i>
                    </template>
                    邀请成员
                  </n-button>
                </div>
                <div
                  v-for="member in groupDetail?.members"
                  :key="member.id"
                  class="member-row flex items-center justify-between p-3 rounded-xl"
                  :class="{ 'member-row--owner': member.role === 'owner' }"
                >
                  <div class="flex items-center gap-3">
                    <n-avatar
                      :size="36"
                      :src="member.avatar || undefined"
                    >
                      <span v-if="!member.avatar">
                        {{ member.nickname?.charAt(0) || member.username.charAt(0) }}
                      </span>
                      <template #fallback>
                        <span class="flex h-full w-full items-center justify-center">
                          {{ member.nickname?.charAt(0) || member.username.charAt(0) }}
                        </span>
                      </template>
                    </n-avatar>
                    <div>
                      <div class="font-semibold text-xs">
                        {{ member.nickname || member.username }}
                      </div>
                      <div class="text-xs text-gray-500">
                        <n-tag
                          v-if="member.role === 'owner'"
                          type="warning"
                          size="tiny"
                        >
                          群主
                        </n-tag>
                        <n-tag
                          v-else-if="member.role === 'admin'"
                          type="info"
                          size="tiny"
                        >
                          管理员
                        </n-tag>
                        <n-tag
                          v-else
                          size="tiny"
                        >
                          成员
                        </n-tag>
                      </div>
                    </div>
                  </div>
                  <div
                    v-if="groupDetail?.myRole === 'owner' && member.role !== 'owner'"
                    class="flex items-center gap-3"
                  >
                    <span
                      class="text-xs"
                      :class="member.canSpeak ? 'text-slate-500' : 'text-red-500'"
                    >
                      {{ member.canSpeak ? '允许发言' : '已被禁言' }}
                    </span>
                    <n-switch
                      :value="member.canSpeak"
                      @update:value="(val: boolean) => handleToggleSpeak(member.id, val)"
                      size="small"
                    ></n-switch>
                  </div>
                  <span
                    v-else-if="member.role === 'owner'"
                    class="text-xs text-slate-400"
                  >
                    拥有最高权限
                  </span>
                </div>
              </div>
            </n-tab-pane>
          </n-tabs>
        </n-spin>
        <template
          #footer
          v-if="currentGroup?.role === 'owner'"
        >
          <div class="danger-zone flex items-center justify-between gap-3">
            <span>删除群组后数据不可恢复</span>
            <n-button
              type="error"
              size="small"
              :loading="deleteLoading"
              @click="handleDeleteGroup"
            >
              删除群组
            </n-button>
          </div>
        </template>
      </n-modal>

      <!-- 编辑群组弹窗 -->
      <n-modal
        v-model:show="showEditModal"
        preset="card"
        class="group-form-modal"
        title="编辑群组"
        style="width: 448px; max-width: calc(100vw - 24px)"
      >
        <n-form
          ref="editFormRef"
          :model="editForm"
          :rules="createRules"
        >
          <n-form-item path="name">
            <template #label>
              <span class="form-label-count">
                群组名称
                <span class="text-red-500">*</span>
                <span>{{ editForm.name.length }} / 50</span>
              </span>
            </template>
            <n-input
              v-model:value="editForm.name"
              placeholder="请输入群组名称"
              maxlength="50"
            />
          </n-form-item>
          <n-form-item>
            <template #label>
              <span class="form-label-count">
                群组简介
                <span>{{ editForm.description.length }} / 200</span>
              </span>
            </template>
            <n-input
              v-model:value="editForm.description"
              type="textarea"
              placeholder="介绍一下您的群组，方便成员了解协作内容..."
              :rows="3"
              maxlength="200"
            />
          </n-form-item>
        </n-form>
        <template #footer>
          <div class="flex justify-end gap-3">
            <n-button @click="showEditModal = false">取消</n-button>
            <n-button
              type="primary"
              :loading="editLoading"
              @click="handleEdit"
            >
              保存
            </n-button>
          </div>
        </template>
      </n-modal>

      <!-- 邀请成员弹窗 -->
      <n-modal
        v-model:show="showInviteModal"
        preset="card"
        class="group-invite-modal"
        title="邀请新成员"
        style="width: 448px; max-width: calc(100vw - 24px)"
      >
        <n-spin :show="usersLoading">
          <div class="invite-search">
            <n-input
              v-model:value="inviteSearch"
              placeholder="搜索联系人姓名..."
              clearable
            >
              <template #prefix>
                <i
                  class="iconfont icon-search"
                  aria-hidden="true"
                ></i>
              </template>
            </n-input>
            <div class="selected-members">
              <span>已选:</span>
              <n-tag
                v-for="user in selectedInviteUsers"
                :key="user.value"
                closable
                size="small"
                type="info"
                @close="inviteUserIds = inviteUserIds.filter((id) => id !== user.value)"
              >
                {{ user.label }}
              </n-tag>
            </div>
          </div>
          <div class="invite-list">
            <label
              v-for="user in filteredInviteUsers"
              :key="user.value"
              class="invite-row"
            >
              <n-avatar
                round
                :size="36"
                :src="user.avatar || undefined"
              >
                <span v-if="!user.avatar">{{ user.label.charAt(0) }}</span>
                <template #fallback>
                  <span class="flex h-full w-full items-center justify-center">
                    {{ user.label.charAt(0) }}
                  </span>
                </template>
              </n-avatar>
              <span class="flex-1 text-xs font-semibold">{{ user.label }}</span>
              <input
                v-model="inviteUserIds"
                type="checkbox"
                :value="user.value"
              />
            </label>
            <n-empty
              v-if="!usersLoading && !filteredInviteUsers.length"
              description="暂无可邀请的联系人"
              class="py-8"
            />
          </div>
        </n-spin>
        <template #footer>
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-slate-500">
              已选择
              <strong class="text-blue-600">{{ inviteUserIds.length }}</strong>
              人
            </span>
            <div class="flex gap-2">
              <n-button @click="showInviteModal = false">取消</n-button>
              <n-button
                type="primary"
                :loading="inviteLoading"
                :disabled="!inviteUserIds.length"
                @click="handleInvite"
              >
                确认邀请
              </n-button>
            </div>
          </div>
        </template>
      </n-modal>
    </div>
  </div>
</template>

<script setup lang="ts">
import { h, ref, reactive, onMounted, onUnmounted, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useDialog, useMessage, type FormInst, type FormRules } from 'naive-ui';
import {
  getMyGroups,
  createGroup,
  getGroupDetail,
  inviteToGroup,
  setMemberPermission,
  updateGroup,
  leaveGroup,
  deleteGroup,
  type Group,
  type GroupDetail as GroupDetailType,
} from '@/api/group';
import { getUserList } from '@/api/auth';
import { useSocketStore } from '@/stores/socket';
import { useUnreadStore } from '@/stores/unread';
import { captureGroupScreen, discardCapturedGroupScreen } from '@/services/screenShareLaunch';
import { isDesktopWindow } from '@/services/desktopAuxiliaryContext';
import { openDesktopGroupWindow } from '@/services/desktopAuxiliaryWindows';
import { groupSessionState } from '@/services/groupSessionState';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const socketStore = useSocketStore();
const unread = useUnreadStore();

const loading = ref(false);
const createLoading = ref(false);
const detailLoading = ref(false);
const inviteLoading = ref(false);
const usersLoading = ref(false);
const deleteLoading = ref(false);

const showCreateModal = ref(false);
const showDetailModal = ref(false);
const showInviteModal = ref(false);
const showEditModal = ref(false);

const groups = ref<Group[]>([]);
const currentGroup = ref<Group | null>(null);
const groupDetail = ref<GroupDetailType | null>(null);
const allUsers = ref<any[]>([]);
const inviteUserIds = ref<number[]>([]);
const inviteSearch = ref('');
const filteredInviteUsers = computed(() =>
  availableUsers.value.filter((user) =>
    user.label.toLowerCase().includes(inviteSearch.value.trim().toLowerCase()),
  ),
);
const selectedInviteUsers = computed(() =>
  availableUsers.value.filter((user) => inviteUserIds.value.includes(user.value)),
);

const createFormRef = ref<FormInst | null>(null);
const createForm = reactive({
  name: '',
  description: '',
});

const editFormRef = ref<FormInst | null>(null);
const editForm = reactive({
  name: '',
  description: '',
});
const editLoading = ref(false);

const createRules: FormRules = {
  name: [
    { required: true, message: '请输入群组名称', trigger: 'blur' },
    { min: 2, max: 50, message: '群组名称长度在2-50个字符', trigger: 'blur' },
  ],
};

// 可邀请的用户列表
const availableUsers = computed(() => {
  if (!groupDetail.value) return [];
  const memberIds = new Set(groupDetail.value.members.map((m) => m.id));
  return allUsers.value
    .filter((user) => !memberIds.has(user.id))
    .map((user) => ({
      label: user.nickname || user.username,
      value: user.id,
      avatar: user.avatar,
    }));
});

// 加载群组列表
async function loadGroups() {
  try {
    loading.value = true;
    const { groups: list } = await getMyGroups();
    groups.value = list;
    socketStore.setSubscribedGroups(list.map((group) => group.id));
  } catch (error: any) {
    message.error('加载群组列表失败: ' + error.message);
  } finally {
    loading.value = false;
  }
}

// 创建群组
async function handleCreate() {
  try {
    await createFormRef.value?.validate();
    createLoading.value = true;

    await createGroup(createForm);
    message.success('创建成功');
    showCreateModal.value = false;

    // 重置表单
    createForm.name = '';
    createForm.description = '';

    // 重新加载列表
    loadGroups();
  } catch (error: any) {
    message.error('创建失败: ' + error.message);
  } finally {
    createLoading.value = false;
  }
}

// 点击群组卡片
async function handleGroupClick(group: Group) {
  currentGroup.value = group;
  showDetailModal.value = true;
  await loadGroupDetail(group.id);
}

// 加载群组详情
async function loadGroupDetail(groupId: number) {
  try {
    detailLoading.value = true;
    groupDetail.value = await getGroupDetail(groupId);
  } catch (error: any) {
    message.error('加载群组详情失败: ' + error.message);
  } finally {
    detailLoading.value = false;
  }
}

// 加载用户列表
async function loadUsers() {
  try {
    usersLoading.value = true;
    const { users } = await getUserList();
    allUsers.value = users;
  } catch (error: any) {
    message.error('加载用户列表失败: ' + error.message);
  } finally {
    usersLoading.value = false;
  }
}

// 当显示邀请弹窗时加载用户列表
watch(showInviteModal, (newVal) => {
  if (newVal) {
    inviteSearch.value = '';
    inviteUserIds.value = [];
    loadUsers();
  }
});

// 邀请成员
async function handleInvite() {
  if (inviteUserIds.value.length === 0) {
    message.warning('请选择要邀请的用户');
    return;
  }

  try {
    inviteLoading.value = true;
    await inviteToGroup(currentGroup.value!.id, inviteUserIds.value);
    message.success('邀请成功');
    showInviteModal.value = false;
    inviteUserIds.value = [];

    // 重新加载群组详情
    if (currentGroup.value) {
      await loadGroupDetail(currentGroup.value.id);
    }
  } catch (error: any) {
    message.error('邀请失败: ' + error.message);
  } finally {
    inviteLoading.value = false;
  }
}

// 切换成员发言权限
async function handleToggleSpeak(userId: number, canSpeak: boolean) {
  try {
    await setMemberPermission(currentGroup.value!.id, userId, canSpeak);
    message.success('权限设置成功');

    // 更新本地数据
    if (groupDetail.value) {
      const member = groupDetail.value.members.find((m) => m.id === userId);
      if (member) {
        member.canSpeak = canSpeak;
      }
    }
  } catch (error: any) {
    message.error('设置失败: ' + error.message);
  }
}

// 群组操作选项
function getGroupOptions(group: Group) {
  const options: any[] = [];

  if (group.role === 'owner' || group.role === 'admin') {
    options.push({
      label: '编辑群组',
      key: 'edit',
    });
  }

  if (group.role !== 'owner') {
    options.push({
      label: '退出群组',
      key: 'leave',
    });
  }

  return options;
}

// 处理群组操作
async function handleGroupAction(key: string, group: Group) {
  if (key === 'edit') {
    // 编辑群组
    currentGroup.value = group;
    editForm.name = group.name;
    editForm.description = group.description || '';
    showEditModal.value = true;
  } else if (key === 'leave') {
    try {
      await leaveGroup(group.id);
      message.success('已退出群组');
      loadGroups();
    } catch (error: any) {
      message.error('退出失败: ' + error.message);
    }
  }
}

// 群组聊天
function handleChatClick(group: Group) {
  router.push(`/group-chat/${group.id}`);
}

// 群组视频通话
function handleVideoCall(group: Group) {
  if (isDesktopWindow) {
    void openDesktopGroupWindow(`/group-video/${group.id}`).catch((error) =>
      message.warning(error.message),
    );
    return;
  }
  router.push(`/group-video/${group.id}`);
}

// 群组屏幕共享
async function handleScreenShare(group: Group) {
  if (isDesktopWindow) {
    try {
      await openDesktopGroupWindow(`/group-screen/${group.id}`);
    } catch (error: any) {
      message.warning(error.message);
    }
    return;
  }
  if (groupSessionState.getSession(group.id, 'screen')) {
    await router.push(`/group-screen/${group.id}`);
    return;
  }
  try {
    await captureGroupScreen(group.id);
    if (socketStore.authenticated)
      socketStore.socket?.emit('group_call_start', { groupId: group.id, deviceType: 2 });
    await router.push(`/group-screen/${group.id}`);
  } catch (error: any) {
    discardCapturedGroupScreen(group.id);
    if (error?.name !== 'NotAllowedError') message.error('无法开始屏幕共享: ' + error.message);
  }
}

// 编辑群组
async function handleEdit() {
  try {
    await editFormRef.value?.validate();
    editLoading.value = true;

    await updateGroup(currentGroup.value!.id, {
      name: editForm.name,
      description: editForm.description,
    });

    message.success('编辑成功');
    showEditModal.value = false;

    // 重新加载列表
    loadGroups();
  } catch (error: any) {
    if (error.message) {
      message.error('编辑失败: ' + error.message);
    }
  } finally {
    editLoading.value = false;
  }
}

// 删除群组
function handleDeleteGroup() {
  const group = currentGroup.value;
  if (!group || group.role !== 'owner') return;

  dialog.warning({
    class: 'group-delete-dialog',
    title: '确认删除群组？',
    showIcon: false,
    closable: false,
    positiveButtonProps: { type: 'error' },
    content: () =>
      h('p', [
        '删除群组后，相关的群消息历史、成员关系和邀请记录都将被',
        h('strong', { style: 'color:#ef4444;font-weight:600' }, '永久删除'),
        '，且无法恢复。',
      ]),
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        deleteLoading.value = true;
        await deleteGroup(group.id);
        groupSessionState.clearGroup(group.id);
        socketStore.leaveGroup(group.id);
        groups.value = groups.value.filter((item) => item.id !== group.id);
        showEditModal.value = false;
        showDetailModal.value = false;
        currentGroup.value = null;
        groupDetail.value = null;
        await loadGroups();
        message.success('群组已删除');
      } catch (error: any) {
        message.error(error.message || '删除群组失败');
      } finally {
        deleteLoading.value = false;
      }
    },
  });
}

// 返回
function goBack() {
  router.back();
}

onMounted(() => {
  loadGroups();
});

onUnmounted(() => {
  groups.value.forEach((group) => socketStore.leaveGroup(group.id));
});
</script>

<style>
.group-card-actions .iconfont {
  width: 18px;
  height: 18px;
  font-size: 16px;
}
/* Match the optical size used by the private and group call entry buttons. */
.group-card-actions .icon-gongxiangpingmu {
  font-size: 14px;
}
.groups-page-actions .iconfont {
  font-size: var(--icon-size-control);
}
.group-card-meta {
  display: flex;
  align-items: center;
  gap: 4px;
}
.group-card-meta .iconfont {
  font-size: var(--icon-size-inline);
  margin: 0;
}
.groups-page {
  background: #f8fafc;
  color: #1e293b;
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.groups-page-header {
  padding-bottom: 22px;
  border-bottom: 1px solid #e2e8f0;
}

.groups-page-title {
  color: #0f172a;
  letter-spacing: -0.03em;
}

.groups-page-description {
  color: #64748b;
  font-size: 14px;
}

.back-button,
.create-group-button {
  min-height: 40px;
  padding-inline: 16px;
  border-radius: 11px;
  font-weight: 600;
}

.back-button {
  --n-color: #fff !important;
  --n-color-hover: #f8fafc !important;
  --n-color-pressed: #f1f5f9 !important;
  --n-text-color: #475569 !important;
  --n-border: 1px solid #e2e8f0 !important;
  --n-border-hover: 1px solid #cbd5e1 !important;
}

.create-group-button {
  --n-color: #2563eb !important;
  --n-color-hover: #1d4ed8 !important;
  --n-color-pressed: #1e40af !important;
  --n-border: 1px solid #2563eb !important;
  --n-border-hover: 1px solid #1d4ed8 !important;
  box-shadow: 0 10px 22px rgba(37, 99, 235, 0.2);
}

.group-grid {
  gap: 20px;
  padding-bottom: 24px;
}

.group-card {
  overflow: hidden;
  border: 1px solid rgba(226, 232, 240, 0.92);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 3px 14px rgba(15, 23, 42, 0.045);
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.group-card:hover {
  border-color: #bfdbfe;
  box-shadow: 0 16px 34px rgba(15, 23, 42, 0.09);
}

.group-card .n-card__content {
  padding: 20px;
}

.group-card .n-card__action {
  padding: 0 20px 18px;
  border-top: 0;
  background: transparent;
}

.group-avatar {
  --n-color: #2563eb !important;
  --n-text-color: #fff !important;
  border-radius: 16px;
  box-shadow: 0 9px 20px rgba(37, 99, 235, 0.18);
}

.group-card-title {
  color: #0f172a;
  font-size: 16px;
}

.group-card-description {
  margin-top: 16px;
  color: #64748b;
  font-size: 12px;
  line-height: 20px;
}

.group-card-meta {
  color: #94a3b8;
}

.group-card-actions {
  display: grid;
  gap: 6px;
  padding-top: 16px;
  border-top: 1px solid #f1f5f9;
}

.group-card-actions--four {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.group-card-actions--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.group-card-actions .n-button {
  --n-color: #f1f5f9 !important;
  --n-color-hover: #e2e8f0 !important;
  --n-color-pressed: #cbd5e1 !important;
  --n-text-color: #475569 !important;
  --n-text-color-hover: #1e293b !important;
  --n-border: 1px solid transparent !important;
  --n-border-hover: 1px solid transparent !important;
  min-width: 0;
  padding-inline: 8px;
  border-radius: 9px;
}

.group-card-actions .n-button:first-child {
  --n-color: #eff6ff !important;
  --n-color-hover: #dbeafe !important;
  --n-color-pressed: #bfdbfe !important;
  --n-text-color: #2563eb !important;
  --n-text-color-hover: #1d4ed8 !important;
}

.group-card .n-tag {
  border-radius: 6px;
  font-size: 10px;
  font-weight: 600;
}

.group-grid .n-empty {
  padding: 64px 24px;
  border: 1px dashed #cbd5e1;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.62);
}

.group-detail-summary {
  padding: 14px;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  background: #f8fafc;
}

.member-management-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.member-row {
  border: 1px solid transparent;
  border-radius: 12px;
  background: #fff;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.member-row:hover {
  border-color: #e2e8f0;
  background: #fff;
}

.danger-zone {
  border-color: #fecaca;
  border-radius: 14px;
  background: rgba(254, 242, 242, 0.88);
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.group-form-modal,
.group-detail-modal,
.group-invite-modal {
  overflow: hidden;
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 20px;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.2);
}

.group-form-modal .n-card-header,
.group-detail-modal .n-card-header,
.group-invite-modal .n-card-header {
  padding: 20px 24px 16px;
  border-bottom: 1px solid #f1f5f9;
}

.group-form-modal .n-card-header__main,
.group-detail-modal .n-card-header__main,
.group-invite-modal .n-card-header__main {
  color: #1e293b;
  font-size: 16px;
  font-weight: 700;
}

.group-form-modal .n-card__content,
.group-detail-modal .n-card__content,
.group-invite-modal .n-card__content {
  padding: 22px 24px;
}

.group-form-modal .n-card__footer,
.group-detail-modal .n-card__footer,
.group-invite-modal .n-card__footer {
  padding: 14px 24px 18px;
  border-top: 1px solid #f1f5f9;
}

.group-form-modal .n-form-item-label {
  color: #475569;
  font-size: 13px;
  font-weight: 600;
}

.group-form-modal .n-input,
.group-invite-modal .n-input {
  --n-color: #f8fafc !important;
  --n-color-focus: #fff !important;
  --n-border: 1px solid #e2e8f0 !important;
  --n-border-hover: 1px solid #93c5fd !important;
  --n-border-focus: 1px solid #3b82f6 !important;
  --n-box-shadow-focus: 0 0 0 2px rgba(59, 130, 246, 0.14) !important;
  border-radius: 11px;
}

.group-form-modal .n-button,
.group-detail-modal .n-button,
.group-invite-modal .n-button {
  min-height: 38px;
  border-radius: 10px;
}

.group-detail-modal .n-tabs-nav {
  border-bottom: 1px solid #f1f5f9;
}

.group-detail-modal .n-tabs-tab {
  font-weight: 600;
}

.group-detail-modal .n-switch {
  --n-rail-color-active: #10b981 !important;
}

.group-delete-dialog {
  width: min(380px, calc(100vw - 32px));
  padding: 24px;
  border-radius: 20px;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24);
}

.group-delete-dialog .n-dialog__icon {
  display: flex;
  width: 48px;
  height: 48px;
  align-items: center;
  justify-content: center;
  margin: 0 auto 14px;
  border-radius: 16px;
  background: #fef3c7;
  color: #d97706;
}

.group-delete-dialog .n-dialog__title {
  justify-content: center;
  color: #0f172a;
  font-size: 16px;
  font-weight: 700;
  text-align: center;
}

.group-delete-dialog .n-dialog__content {
  margin-top: 10px;
  color: #64748b;
  font-size: 13px;
  line-height: 21px;
  text-align: center;
}

.group-delete-dialog .n-dialog__action {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 22px;
}

.group-delete-dialog .n-dialog__action .n-button {
  width: 100%;
  min-height: 40px;
  border-radius: 11px;
}

@media (max-width: 640px) {
  .groups-shell {
    padding: 16px 12px;
  }

  .groups-page-header {
    align-items: flex-start;
    padding-bottom: 16px;
  }

  .groups-page-title {
    font-size: 24px;
  }

  .groups-page-description {
    font-size: 12px;
  }

  .groups-page-actions {
    width: 100%;
    justify-content: space-between;
  }

  .back-button,
  .create-group-button {
    min-height: 44px;
  }

  .group-grid {
    gap: 14px;
    padding-right: 0;
  }

  .group-card .n-card__content {
    padding: 16px;
  }

  .group-card .n-card__action {
    padding: 0 16px 16px;
  }

  .group-card-main {
    gap: 12px;
  }

  .group-card-actions .n-button {
    min-height: 44px;
  }

  .group-form-modal,
  .group-invite-modal,
  .group-detail-modal {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    width: 100% !important;
    max-width: none !important;
    max-height: min(88dvh, 760px);
    margin: 0;
    border-width: 0;
    border-radius: 24px 24px 0 0;
  }

  .group-form-modal::before,
  .group-invite-modal::before,
  .group-detail-modal::before {
    content: '';
    display: block;
    width: 40px;
    height: 4px;
    margin: 10px auto 0;
    border-radius: 999px;
    background: #cbd5e1;
  }

  .group-form-modal .n-card-header,
  .group-detail-modal .n-card-header,
  .group-invite-modal .n-card-header {
    padding: 14px 20px;
  }

  .group-form-modal .n-card__content,
  .group-detail-modal .n-card__content,
  .group-invite-modal .n-card__content {
    overflow-y: auto;
    padding: 18px 20px;
  }

  .group-form-modal .n-card__footer,
  .group-detail-modal .n-card__footer,
  .group-invite-modal .n-card__footer {
    padding: 12px 20px max(16px, env(safe-area-inset-bottom));
  }

  .group-detail-summary {
    align-items: flex-start;
  }

  .member-row {
    gap: 12px;
  }

  .group-delete-dialog {
    width: calc(100vw - 28px);
    padding: 22px 18px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .group-card {
    transition: none;
  }
}

.group-avatar {
  background: linear-gradient(to top right, #3b82f6, #4f46e5);
}
.group-card {
  border-radius: 16px;
  box-shadow: 0 1px 2px #0000000d;
}
.group-card .n-card__content {
  padding-bottom: 16px;
}
.group-card .n-card__action {
  padding-bottom: 20px;
}
.member-row--owner {
  background: #f8fafc;
}
.danger-zone {
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #dc2626;
  font-size: 12px;
}
.group-detail-modal .n-card__footer {
  padding: 16px;
  background: #fef2f280;
  border-top: 1px solid #fee2e2;
}
.group-detail-modal .n-card__content {
  overflow: auto;
  max-height: 65dvh;
}
.group-form-modal,
.group-detail-modal,
.group-invite-modal {
  border-radius: 16px;
}
.group-invite-modal {
  height: min(600px, 85dvh);
}
.group-invite-modal .n-card__content {
  padding: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.group-invite-modal .n-spin-container,
.group-invite-modal .n-spin-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.invite-search {
  padding: 16px;
  border-bottom: 1px solid #f1f5f9;
  background: #f8fafc80;
}
.selected-members {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  margin-top: 12px;
  font-size: 11px;
  color: #94a3b8;
  white-space: nowrap;
}
.invite-list {
  flex: 1;
  overflow: auto;
  padding: 12px;
}
.invite-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 12px;
  cursor: pointer;
}
.invite-row:hover {
  background: #f8fafc;
}
.invite-row input {
  width: 16px;
  height: 16px;
  accent-color: #2563eb;
}
.group-delete-dialog::before {
  content: '\f071';
  font-family: 'Design Icons';
  font-weight: 900;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  margin: 0 auto 16px;
  color: #d97706;
  background: #fef3c7;
  border-radius: 16px;
  font-size: 20px;
}
.group-delete-dialog .n-dialog__content {
  font-size: 12px;
}
@media (max-width: 640px) {
  .groups-shell {
    padding: 24px 16px;
  }
  .groups-page-title {
    font-size: 20px;
  }
  .group-form-modal,
  .group-invite-modal {
    border-radius: 24px 24px 0 0;
  }
  .group-invite-modal {
    height: 80dvh;
  }
}

.form-label-count {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
}
.form-label-count > span:last-child {
  margin-left: auto;
  color: #94a3b8;
  font-size: 11px;
  font-weight: 400;
}
.group-form-modal .n-form-item-label__text {
  width: 100%;
}
.group-form-modal .n-form-item-label__asterisk {
  display: none;
}
.group-form-modal .n-input {
  --n-height: 42px !important;
}
.n-modal-container:has(
    .group-form-modal,
    .group-detail-modal,
    .group-invite-modal,
    .group-delete-dialog
  )
  .n-modal-mask {
  background: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(4px);
}
.group-form-modal .n-card__footer {
  border: 0;
  padding-top: 0;
}
.group-detail-modal .member-management-header .n-button {
  --n-color: #eff6ff !important;
  --n-color-hover: #dbeafe !important;
  --n-text-color: #2563eb !important;
  --n-border: 0 !important;
  min-height: 28px;
  font-size: 12px;
}
@media (max-width: 640px) {
  .group-form-modal .n-card__footer .n-button {
    flex: 1;
    height: 42px;
  }
}

.group-delete-dialog .n-dialog__action .n-button:first-child {
  --n-border: 1px solid #e2e8f0 !important;
  --n-text-color: #334155 !important;
}
.group-invite-modal .selected-members .n-tag {
  border: 0;
  border-radius: 6px;
  padding: 4px 8px;
  height: 24px;
  background: #eff6ff;
}
.group-detail-modal .member-row .n-tag {
  border: 0;
  font-size: 10px;
}
.group-detail-modal .n-card-header {
  border-bottom: 0;
  padding-bottom: 0;
}
.group-detail-modal .n-card__content {
  padding-top: 12px;
}
@media (max-width: 640px) {
  .group-detail-modal {
    position: relative;
    inset: auto;
    width: calc(100vw - 32px) !important;
    max-height: 85dvh;
    margin: auto;
    border-radius: 16px;
  }
  .group-detail-modal::before {
    display: none;
  }
}
</style>
