/**
 * astral-trek side wiring for the vendored OneDrive sync engine
 * (nightfall-yl/obsidian-third-party-sync@6240bcc).
 *
 * Owns: settings access, the internal DB + vaultRandomID lifecycle, the
 * remote client, vault delete/rename history recording, auto-sync timers,
 * the OAuth callback protocol handler and sync status notifications.
 */

import type {
  App,
  EventRef,
  TAbstractFile} from "obsidian";
import {
  Modal,
  Notice,
  TFile,
  normalizePath,
  setIcon,
} from "obsidian";

import type AstraDashboardPlugin from "../main";
import { t as $t } from "../i18n";
import type {
  ConflictActionType,
  SyncDirectionType,
  SyncTriggerSourceType,
} from "./baseTypes";
import { COMMAND_CALLBACK_ONEDRIVE } from "./baseTypes";
import {
  getAuthUrlAndVerifier,
  sendAuthReq,
  setConfigBySuccessfullAuthInplace,
} from "./remoteForOnedrive";
import { RemoteClient } from "./remote";
import type { InternalDBs } from "./localdb";
import {
  clearAllPrevSyncRecordsByVault,
  insertDeleteRecordByVault,
  insertRenameRecordByVault,
  loadPrevSyncRecordsByVault,
  prepareDBs,
} from "./localdb";
import { listFilesInObsFolder } from "./obsFolderLister";
import {
  isPasswordOk,
  getRemoteStates,
  getSyncPlanV3,
  doActualSyncV3,
  type SyncStatusType,
} from "./syncEngine";
import { setSyncDebugEnabled, syncLog } from "./log";

/** 同步运行中需要实时显示到状态栏的步骤（→ i18n 键） */
const SYNC_STATUS_STEP_KEYS: Partial<Record<SyncStatusType, string>> = {
  getting_remote_files_list: "sync.progress.getting_remote_files_list",
  checking_password: "sync.progress.checking_password",
  getting_remote_extra_meta: "sync.progress.getting_remote_extra_meta",
  getting_local_meta: "sync.progress.getting_local_meta",
  generating_plan: "sync.progress.generating_plan",
  syncing: "sync.progress.syncing",
};

/** 上次成功同步的相对时间文案（移植自上游 misc.ts getLastSynced 的分级） */
function formatLastSyncedRelative(ms: number): { msg: string; label: string } {
  const deltaTime = Date.now() - ms;
  const years = Math.floor(deltaTime / 31556952000);
  const months = Math.floor(deltaTime / 2629746000);
  const weeks = Math.floor(deltaTime / 604800000);
  const days = Math.floor(deltaTime / 86400000);
  const hours = Math.floor(deltaTime / 3600000);
  const minutes = Math.floor(deltaTime / 60000);
  let timeText: string;
  if (years > 0) {
    timeText = $t("sync.statusbar.years", { time: years });
  } else if (months > 0) {
    timeText = $t("sync.statusbar.months", { time: months });
  } else if (weeks > 0) {
    timeText = $t("sync.statusbar.weeks", { time: weeks });
  } else if (days > 0) {
    timeText = $t("sync.statusbar.days", { time: days });
  } else if (hours > 0) {
    timeText = $t("sync.statusbar.hours", { time: hours });
  } else if (minutes > 0) {
    timeText = $t("sync.statusbar.minutes", { time: minutes });
  } else {
    timeText = $t("sync.statusbar.lessminute");
  }

  // aria-label 用完整日期时间（对齐上游 statusbar_lastsync_label）
  const dateText = new Date(ms).toLocaleTimeString(navigator.language, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return {
    msg: $t("sync.statusbar.lastsync", { time: timeText }),
    label: $t("sync.statusbar.lastsyncLabel", { date: dateText }),
  };
}

export interface SyncStatusInfo {
  status: SyncStatusType;
  /** 人类可读的进度描述（已完成/总数等） */
  message?: string;
  lastError?: string;
}

/** 授权过程中保存在内存里的 PKCE verifier（不落盘） */
interface OAuth2Info {
  verifier: string;
  helperModal: OneDriveAuthHelperModal | null;
}

class OneDriveAuthHelperModal extends Modal {
  constructor(
    app: App,
    private readonly onFinished: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("p", {
      text: $t("sync.auth.waitingHint"),
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  finish(): void {
    this.close();
    this.onFinished();
  }
}

export class SyncManager {
  private readonly plugin: AstraDashboardPlugin;
  private db: InternalDBs | null = null;
  private vaultRandomID = "";
  private client: RemoteClient | null = null;
  private syncing = false;
  private oauth2Info: OAuth2Info | null = null;

  private statusListeners = new Set<(info: SyncStatusInfo) => void>();
  private currentStatus: SyncStatusInfo = { status: "idle" };

  private autoRunTimer: number | null = null;
  private initRunTimer: number | null = null;
  private onSaveTimer: number | null = null;
  /** 状态栏相对时间刷新定时器（对齐上游 30s interval） */
  private statusBarTimer: number | null = null;
  private statusBarItemEl: HTMLElement | null = null;

  private vaultEventRefs: EventRef[] = [];

  constructor(plugin: AstraDashboardPlugin) {
    this.plugin = plugin;
  }

  // ─────────────────────────── lifecycle ───────────────────────────

  async onload(): Promise<void> {
    setSyncDebugEnabled(this.plugin.data.settings.sync.debug ?? false);

    // OAuth 回调：始终注册（未启用时也允许完成一次授权流程）
    this.plugin.registerObsidianProtocolHandler(
      COMMAND_CALLBACK_ONEDRIVE,
      (data) => {
        void this.handleOAuthCallback(data.code ?? "", data.state ?? "");
      }
    );

    try {
      const r = await prepareDBs(this.plugin.app.vault.getName(), "");
      this.db = r.db;
      this.vaultRandomID = r.vaultRandomID;
    } catch (err) {
      syncLog.error("prepareDBs failed", err);
    }

    this.applyEnabled();

    // 状态栏相对时间每 30s 刷新（同步中让位于实时步骤显示；对齐上游）
    this.statusBarTimer = window.setInterval(() => {
      if (!this.syncing) {
        this.updateStatusBar();
      }
    }, 30_000);
  }

  onunload(): void {
    this.clearTimers();
    this.unregisterVaultEvents();
    this.oauth2Info?.helperModal?.close();
    this.oauth2Info = null;
    this.statusBarItemEl?.remove();
    this.statusBarItemEl = null;
  }

  get isReady(): boolean {
    return this.db !== null && this.vaultRandomID !== "";
  }

  get isSyncing(): boolean {
    return this.syncing;
  }

  getStatus(): SyncStatusInfo {
    return this.currentStatus;
  }

  onStatusChange(listener: (info: SyncStatusInfo) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(status: SyncStatusType, message?: string): void {
    this.currentStatus = { ...this.currentStatus, status, message };
    for (const listener of this.statusListeners) {
      listener(this.currentStatus);
    }
    this.updateStatusBarProgress();
  }

  /** 同步运行中：状态栏实时显示当前步骤（结束后由 finally 恢复为上次同步时间） */
  private updateStatusBarProgress(): void {
    const stepKey = SYNC_STATUS_STEP_KEYS[this.currentStatus.status];
    if (!this.syncing || stepKey === undefined) return;
    if (this.statusBarItemEl === null) {
      this.statusBarItemEl = this.plugin.addStatusBarItem();
    }
    const step =
      $t(stepKey) +
      (this.currentStatus.status === "syncing" && this.currentStatus.message
        ? ` ${this.currentStatus.message}`
        : "");
    this.statusBarItemEl.setText(
      $t("sync.status.statusBarProgress", { step })
    );
  }

  /** 应用 enabled 开关：注册/注销 vault 事件与定时器 */
  applyEnabled(): void {
    const s = this.plugin.data.settings.sync;
    this.clearTimers();
    this.unregisterVaultEvents();

    if (!s.enabled) {
      return;
    }

    this.registerVaultEvents();

    if (s.initRunAfterMilliseconds > 0) {
      this.initRunTimer = window.setTimeout(() => {
        void this.syncRun("autoOnceInit").catch((err) => {
          syncLog.error("init sync failed", err);
        });
      }, s.initRunAfterMilliseconds);
    }
    if (s.autoRunEveryMilliseconds > 0) {
      this.autoRunTimer = window.setInterval(() => {
        void this.syncRun("auto").catch((err) => {
          syncLog.error("auto sync failed", err);
        });
      }, s.autoRunEveryMilliseconds);
    }
    this.updateStatusBar();
  }

  /** 状态栏：空闲时显示上次成功同步的相对时间（对齐上游） */
  private updateStatusBar(): void {
    const s = this.plugin.data.settings.sync;
    if (!s.enabled) {
      this.statusBarItemEl?.remove();
      this.statusBarItemEl = null;
      return;
    }
    if (this.statusBarItemEl === null) {
      this.statusBarItemEl = this.plugin.addStatusBarItem();
    }
    if (s.lastSynced === -1) {
      this.statusBarItemEl.setText($t("sync.statusbar.never"));
      this.statusBarItemEl.setAttribute("aria-label", $t("sync.statusbar.neverLabel"));
      return;
    }
    const { msg, label } = formatLastSyncedRelative(s.lastSynced);
    this.statusBarItemEl.setText(msg);
    this.statusBarItemEl.setAttribute("aria-label", label);
  }

  private clearTimers(): void {
    if (this.autoRunTimer !== null) {
      window.clearInterval(this.autoRunTimer);
      this.autoRunTimer = null;
    }
    if (this.initRunTimer !== null) {
      window.clearTimeout(this.initRunTimer);
      this.initRunTimer = null;
    }
    if (this.onSaveTimer !== null) {
      window.clearTimeout(this.onSaveTimer);
      this.onSaveTimer = null;
    }
    if (this.statusBarTimer !== null) {
      window.clearInterval(this.statusBarTimer);
      this.statusBarTimer = null;
    }
  }

  private registerVaultEvents(): void {
    if (this.vaultEventRefs.length > 0) {
      return;
    }
    const s = this.plugin.data.settings.sync;

    // 删除/重命名历史是三向合并的核心输入，必须始终记录
    const deleteRef = this.plugin.app.vault.on("delete", (file) => {
      if (this.db !== null) {
        void insertDeleteRecordByVault(this.db, file, this.vaultRandomID);
      }
    });
    this.vaultEventRefs.push(deleteRef);
    const renameRef = this.plugin.app.vault.on("rename", (file, oldPath) => {
      if (this.db !== null) {
        void insertRenameRecordByVault(
          this.db,
          file,
          oldPath,
          this.vaultRandomID
        );
      }
    });
    this.vaultEventRefs.push(renameRef);

    // 保存后防抖自动同步（syncOnSaveAfterMilliseconds > 0 时启用）
    if (s.syncOnSaveAfterMilliseconds > 0) {
      const debounceMs = s.syncOnSaveAfterMilliseconds;
      const modifyRef = this.plugin.app.vault.on("modify", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) {
          return;
        }
        if (this.onSaveTimer !== null) {
          window.clearTimeout(this.onSaveTimer);
        }
        this.onSaveTimer = window.setTimeout(() => {
          this.onSaveTimer = null;
          void this.syncRun("auto").catch((err) => {
            syncLog.error("sync-on-save failed", err);
          });
        }, debounceMs);
      });
      this.vaultEventRefs.push(modifyRef);
    }
  }

  private unregisterVaultEvents(): void {
    for (const ref of this.vaultEventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.vaultEventRefs = [];
  }

  // ─────────────────────────── auth ───────────────────────────

  get isAuthorized(): boolean {
    const cfg = this.plugin.data.settings.sync.onedriveConfig;
    return cfg.refreshToken !== "" && cfg.clientID !== "";
  }

  async startAuth(): Promise<void> {
    const s = this.plugin.data.settings.sync;
    const clientID = s.onedriveConfig.clientID.trim();
    if (clientID === "") {
      new Notice($t("sync.auth.needClientId"));
      return;
    }
    const { authUrl, verifier } = await getAuthUrlAndVerifier(
      clientID,
      s.onedriveConfig.authority
    );
    const helperModal = new OneDriveAuthHelperModal(this.plugin.app, () => {
      this.oauth2Info = null;
    });
    helperModal.open();
    this.oauth2Info = { verifier, helperModal };
    window.open(authUrl);
  }

  private async handleOAuthCallback(
    code: string,
    _state: string
  ): Promise<void> {
    if (this.oauth2Info === null || code === "") {
      new Notice($t("sync.auth.callbackNoVerifier"));
      return;
    }
    const s = this.plugin.data.settings.sync;
    const clientID = s.onedriveConfig.clientID.trim();
    try {
      const authRes = await sendAuthReq(
        clientID,
        s.onedriveConfig.authority,
        code,
        this.oauth2Info.verifier
      );
      if ("error" in authRes) {
        throw new Error(authRes.error_description ?? authRes.error);
      }
      await setConfigBySuccessfullAuthInplace(
        s.onedriveConfig,
        authRes,
        () => this.plugin.saveSettings()
      );
      // 拉取用户名用于展示
      try {
        const client = this.getClient();
        s.onedriveConfig.username = await client.getUser();
        await this.plugin.saveSettings();
      } catch (err) {
        syncLog.warn("getUser failed after auth", err);
      }
      new Notice($t("sync.auth.success"));
    } catch (err) {
      syncLog.error("auth callback failed", err);
      new Notice(
        $t("sync.auth.failed", { msg: err instanceof Error ? err.message : String(err) })
      );
    } finally {
      this.oauth2Info?.helperModal?.finish();
      this.oauth2Info = null;
      this.notifySettingsRefresh();
    }
  }

  async revokeAuth(): Promise<void> {
    const s = this.plugin.data.settings.sync;
    s.onedriveConfig.accessToken = "";
    s.onedriveConfig.refreshToken = "";
    s.onedriveConfig.accessTokenExpiresAtTime = 0;
    s.onedriveConfig.accessTokenExpiresInSeconds = 0;
    s.onedriveConfig.username = "";
    await this.plugin.saveSettings();
    this.client = null;
    new Notice($t("sync.auth.revoked"));
    this.notifySettingsRefresh();
  }

  /** 设置页「检查可否连接」：读取 OneDrive 账户信息验证授权与网络。 */
  async checkConnection(): Promise<void> {
    new Notice($t("sync.action.checkConnChecking"));
    const errors = { msg: "" };
    const res = await this.getClient().checkConnectivity((err) => {
      if (err instanceof Error) {
        errors.msg = err.message;
      } else if (typeof err === "string") {
        errors.msg = err;
      } else if (err !== undefined) {
        errors.msg = JSON.stringify(err);
      }
    });
    if (res) {
      new Notice($t("sync.action.checkConnSucc"));
    } else {
      new Notice($t("sync.action.checkConnFail"));
      if (errors.msg !== "") {
        new Notice(errors.msg);
      }
    }
  }

  /** 删除同步映射记录（prevSync 基线），用于授权账号/密码变更后强制全量比对 */
  async clearLocalSyncData(): Promise<void> {
    if (this.db !== null) {
      await clearAllPrevSyncRecordsByVault(this.db, this.vaultRandomID);
    }
    this.plugin.data.settings.sync.lastSynced = -1;
    await this.plugin.saveSettings();
    new Notice($t("sync.action.clearedLocal"));
  }

  /** 设置页整页重渲染钩子：设置页打开时由 renderSyncSettings 注册、关闭时（hide）置空。
   *  授权状态变化（OAuth 回调成功 / 撤回鉴权）后用它通知设置页即时刷新，
   *  否则「撤回鉴权」按钮要等用户切走再切回设置页才出现。 */
  private settingsRerenderCb: (() => void) | null = null;

  registerSettingsRerender(cb: (() => void) | null): void {
    this.settingsRerenderCb = cb;
  }

  private notifySettingsRefresh(): void {
    this.settingsRerenderCb?.();
  }

  // ─────────────────────────── sync run ───────────────────────────

  /** Vault Sync ribbon 元素（main.ts 创建后挂进来，同步中切换图标） */
  syncRibbon: HTMLElement | null = null;

  /** ribbon 图标随同步状态切换（移植自上游 setSyncIcon） */
  private setSyncIcon(
    running: boolean,
    triggerSource?: SyncTriggerSourceType
  ): void {
    if (!this.syncRibbon) return;
    if (running) {
      setIcon(this.syncRibbon, "refresh-ccw");
      this.syncRibbon.setAttribute(
        "aria-label",
        $t("sync.ribbon.syncing", {
          pluginName: this.plugin.manifest.name,
          triggerSource: triggerSource ?? "",
        })
      );
    } else {
      setIcon(this.syncRibbon, "rotate-ccw");
      this.syncRibbon.setAttribute("aria-label", $t("sync.ribbon.tip"));
    }
  }

  private getClient(): RemoteClient {
    const s = this.plugin.data.settings.sync;
    if (this.client === null) {
      this.client = new RemoteClient(
        "onedrive",
        s.onedriveConfig,
        this.plugin.app.vault.getName(),
        () => this.plugin.saveSettings()
      );
    }
    return this.client;
  }

  /**
   * 主同步入口（移植自上游 main.ts syncRun 的 V3 流程）。
   * @param triggerSource 触发来源
   * @param silent 静默模式（自动触发时不弹 Notice，仅记录日志）
   */
  async syncRun(
    triggerSource: SyncTriggerSourceType,
    silent = false
  ): Promise<void> {
    const s = this.plugin.data.settings.sync;
    if (!s.enabled) {
      if (!silent) {
        new Notice($t("sync.status.notEnabled"));
      }
      return;
    }
    if (this.syncing) {
      if (!silent) {
        new Notice($t("sync.status.alreadySyncing"));
      }
      return;
    }
    if (!this.isReady || this.db === null) {
      if (!silent) {
        new Notice($t("sync.status.dbNotReady"));
      }
      return;
    }
    if (!this.isAuthorized) {
      if (!silent) {
        new Notice($t("sync.status.notAuthorized"));
      }
      return;
    }

    this.syncing = true;
    this.setSyncIcon(true, triggerSource);
    // 与上游语义一致：空密码 = 不加密
    const password = s.password;
    try {
      const client = this.getClient();

      this.setStatus("getting_remote_files_list");
      const listFromRemoteRes = await client.listFromRemote();

      this.setStatus("checking_password");
      const pwdCheck = await isPasswordOk(listFromRemoteRes.Contents, password);
      if (!pwdCheck.ok) {
        throw new Error(
          $t("sync.error.passwordNotMatched", {
            reason: String(pwdCheck.reason),
          })
        );
      }

      this.setStatus("getting_remote_extra_meta");
      const remoteStates = await getRemoteStates(
        listFromRemoteRes.Contents,
        this.db,
        this.vaultRandomID,
        "onedrive",
        password
      );

      this.setStatus("getting_local_meta");
      const local = this.plugin.app.vault.getAllLoadedFiles();
      const localConfigDirContents =
        s.syncConfigDir || s.syncTrash
          ? await listFilesInObsFolder(
              this.plugin.app.vault,
              this.plugin.manifest.id,
              s.syncTrash
            )
          : undefined;

      this.setStatus("generating_plan");
      const prevSyncRecords = await loadPrevSyncRecordsByVault(
        this.db,
        this.vaultRandomID
      );
      const plan = await getSyncPlanV3(
        remoteStates,
        local,
        localConfigDirContents,
        prevSyncRecords,
        "onedrive",
        triggerSource,
        this.plugin.app.vault,
        s.syncConfigDir,
        s.syncTrash,
        s.syncBookmarks,
        this.plugin.app.vault.configDir,
        s.syncUnderscoreItems,
        s.skipSizeLargerThan,
        password,
        s.syncDirection,
        s.conflictAction
      );

      const uploadCount = plan.sortedKeys.filter((key) => {
        const d = plan.plan.mixedStates[key]?.decision;
        return d === "uploadLocalToRemote" || d === "createFolder";
      }).length;
      const downloadCount = plan.sortedKeys.filter(
        (key) => plan.plan.mixedStates[key]?.decision === "downloadRemoteToLocal"
      ).length;
      const deleteCount = plan.sortedKeys.filter((key) => {
        const d = plan.plan.mixedStates[key]?.decision;
        return (
          d === "uploadLocalDelHistToRemote" ||
          d === "uploadLocalDelHistToRemoteFolder"
        );
      }).length;
      syncLog.debug(
        `sync plan: upload=${uploadCount}, download=${downloadCount}, delete=${deleteCount}`
      );

      this.setStatus("syncing", `0/${plan.sortedKeys.length}`);
      const lastSyncedTime = await doActualSyncV3(
        client,
        this.db,
        this.vaultRandomID,
        this.plugin.app.vault,
        plan.plan,
        plan.sortedKeys,
        plan.sizesGoWrong,
        async (key: string) => {
          const p = normalizePath(key);
          // 插件级「删除到哪里」设置须优先于 Obsidian 全局偏好（FileManager.trashFile
          // 跟随全局设置，无法保证送系统回收站）；移动端不支持系统回收站时
          // trashSystem 返回 false，回退 Obsidian .trash
          if (
            s.deleteToWhere === "system_trash" &&
            (await this.plugin.app.vault.adapter.trashSystem(p))
          ) {
            return;
          }
          await this.plugin.app.vault.adapter.trashLocal(p);
        },
        password,
        s.lastSynced,
        s.concurrency,
        (items) => {
          new Notice(
            $t("sync.error.sizesGoWrong", {
              count: items.length,
              first: items[0]?.key ?? "",
            })
          );
        },
        async (index, total) => {
          this.setStatus("syncing", `${index}/${total}`);
        },
        s.protectModifyPercentage >= 0
          ? s.protectModifyPercentage
          : undefined,
        (errorMsg) => {
          new Notice($t("sync.error.protectModifyPercentage", { msg: errorMsg }));
        },
        this.plugin.app.vault.configDir,
        s.syncDirection
      );

      if (lastSyncedTime !== undefined) {
        s.lastSynced = lastSyncedTime;
        await this.plugin.saveSettings();
        this.updateStatusBar();
      }

      this.setStatus("finish");
      if (!silent) {
        new Notice(
          $t("sync.status.finished", {
            upload: uploadCount,
            download: downloadCount,
            del: deleteCount,
          })
        );
      }
    } catch (err) {
      syncLog.error("sync run failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      this.currentStatus = {
        ...this.currentStatus,
        status: "idle",
        lastError: msg,
      };
      for (const listener of this.statusListeners) {
        listener(this.currentStatus);
      }
      new Notice(
        $t("sync.error.syncFailed", {
          msg: msg.length > 200 ? `${msg.slice(0, 200)}…` : msg,
        })
      );
      return;
    } finally {
      this.syncing = false;
      this.setSyncIcon(false);
      this.updateStatusBar();
    }

    // 成功结束后短暂停留再回到 idle
    window.setTimeout(() => {
      if (!this.syncing && this.currentStatus.status === "finish") {
        this.setStatus("idle");
      }
    }, 2000);
  }

  async changeSyncDirection(direction: SyncDirectionType): Promise<void> {
    this.plugin.data.settings.sync.syncDirection = direction;
    await this.plugin.saveSettings();
  }

  async changeConflictAction(action: ConflictActionType): Promise<void> {
    this.plugin.data.settings.sync.conflictAction = action;
    await this.plugin.saveSettings();
  }
}
