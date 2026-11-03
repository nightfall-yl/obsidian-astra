import { t as $t } from "./i18n";
import { unixTimeToStr } from "./sync/misc";
import {
  AbstractInputSuggest,
  Modal,
  PluginSettingTab,
  Setting,
  SettingGroup,
  TFolder,
  TFile,
  normalizePath,
  setIcon,
} from "obsidian";
import type { App, SettingDefinitionItem } from "obsidian";
import type {
  SyncDirectionType,
  ConflictActionType,
  DeleteToWhereType,
} from "./sync/baseTypes";
import type AstraDashboardPlugin from "./main";
import type { StartupMode, SearchSettings } from "./models";
import {
  DEFAULT_CALENDAR_SETTINGS,
  DEFAULT_CURSOR_POSITION_SETTINGS,
  DEFAULT_QUICK_CAPTURE_SETTINGS,
  DEFAULT_DIARY_SETTINGS,
  DEFAULT_COUNTDOWN_SETTINGS,
  DEFAULT_DAILY_PHRASE_SETTINGS,
  DEFAULT_SEARCH_SETTINGS
} from "./models";
import { lightSchemeOptions, darkSchemeOptions } from "./minimal/schemes";

export class AstraSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly astraPlugin: AstraDashboardPlugin
  ) {
    super(app, astraPlugin);
  }

  display(): void {
    renderSettings(this.containerEl, this.astraPlugin);
  }

  hide(): void {
    super.hide();
    // 解除同步页的重渲染钩子，避免设置页关闭后 syncManager 仍持有已脱离 DOM 的回调
    this.astraPlugin.syncManager.registerSettingsRerender(null);
  }

  /**
   * 声明式设置 API（Obsidian 1.13+）：
   * 本插件设置页为命令式构建（见下方 renderSettings），返回空数组以保持
   * Obsidian 继续调用 display() 走命令式渲染，避免声明式接管整页设置。
   * 该空实现仅为显式声明“已采纳声明式接口”，供设置搜索/校验器识别。
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  getControlValue(): unknown {
    return undefined;
  }

  setControlValue(_key: string, _value: unknown): void | Promise<void> {}
}

/**
 * 「项目文件夹」输入框的文件夹联想（学习 Obsidian 官方「文件与链接 → 附件文件夹路径」的
 * FolderSuggest：输入时按路径前缀联想库内文件夹，选中后回填相对路径）。
 */
class ProjectFolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly onApply: (path: string) => void
  ) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const lower = query.trim().toLowerCase();
    const folders: TFolder[] = [];
    const limit = this.limit || 100;
    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFolder)) continue;
      if (folders.length >= limit) break;
      // 根目录不列为建议
      if (file.path === "/") continue;
      // 空查询列出全部文件夹；否则按「任一段路径包含」联想
      if (!lower || file.path.toLowerCase().includes(lower)) folders.push(file);
    }
    return folders;
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(folder.path);
    this.close();
    this.onApply(folder.path);
  }
}

/**
 * 「快速捕获文件」输入框的文件联想（与「项目文件夹」的 FolderSuggest 同一交互，面向库内 md 笔记）。
 */
class ProjectFileSuggest extends AbstractInputSuggest<TFile> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly onApply: (path: string) => void
  ) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFile[] {
    const lower = query.trim().toLowerCase();
    const files: TFile[] = [];
    const limit = this.limit || 100;
    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFile) || file.extension !== "md") continue;
      if (files.length >= limit) break;
      if (!lower || file.path.toLowerCase().includes(lower)) files.push(file);
    }
    return files;
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  selectSuggestion(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(file.path);
    this.close();
    this.onApply(file.path);
  }
}

type SettingsSection = {
  id: string;
  label: string;
  icon: string;
};

function renderSettings(
  container: HTMLElement,
  plugin: AstraDashboardPlugin
): void {
  container.empty();
  container.addClass("astra-settings-root");

  // Defensive: ensure new settings exist (in case data.json predates migration)
  try {
  if (!plugin.data.settings.calendar) {
    plugin.data.settings.calendar = { ...DEFAULT_CALENDAR_SETTINGS };
  }
  if (!plugin.data.settings.cursorPosition) {
    plugin.data.settings.cursorPosition = { ...DEFAULT_CURSOR_POSITION_SETTINGS };
  }
  if (!plugin.data.settings.quickCapture) {
    plugin.data.settings.quickCapture = { ...DEFAULT_QUICK_CAPTURE_SETTINGS };
  } else {
    // 迁移旧字段：旧版按「文件夹 + 命名模板」每日新建笔记；新版改为追加写入指定文件
    const qc = plugin.data.settings.quickCapture as typeof plugin.data.settings.quickCapture & {
      storagePath?: string;
      namingPattern?: string;
      templateFile?: string;
    };
    if (typeof qc.filePath !== "string" || !qc.filePath.trim()) {
      const dir = (qc.storagePath ?? "").trim().replace(/\/+$/, "");
      // 只从旧字段继承目录；没有则留空，由用户在设置里自行选择
      qc.filePath = dir ? `${dir}/快速捕获.md` : "";
      delete qc.storagePath;
      delete qc.namingPattern;
      delete qc.templateFile;
    }
  }
  if (!plugin.data.settings.diary) {
    plugin.data.settings.diary = { ...DEFAULT_DIARY_SETTINGS };
  }
  if (!plugin.data.settings.countdown) {
    plugin.data.settings.countdown = { ...DEFAULT_COUNTDOWN_SETTINGS };
  }
  if (!plugin.data.settings.search) {
    plugin.data.settings.search = { ...DEFAULT_SEARCH_SETTINGS };
  }
  if (!plugin.data.settings.dailyPhrase) {
    plugin.data.settings.dailyPhrase = { ...DEFAULT_DAILY_PHRASE_SETTINGS };
  }
  if (!plugin.data.settings.npdpStages) {
    plugin.data.settings.npdpStages = ["Charter", "PDCP", "TR", "ADCP", "COR"];
  }
  if (typeof plugin.data.settings.projectsFolder !== "string") {
    plugin.data.settings.projectsFolder = "Projects";
  }
  // Defensive: ensure project-board (gantt/list) settings exist for older data.json
  if (typeof plugin.data.settings.currentPoView !== "string") {
    plugin.data.settings.currentPoView = "gantt";
  }
  if (typeof plugin.data.settings.poGanttScale !== "string") {
    plugin.data.settings.poGanttScale = "week";
  }
  if (!Array.isArray(plugin.data.settings.poGanttStatusFilter)) {
    plugin.data.settings.poGanttStatusFilter = [];
  }
  if (!Array.isArray(plugin.data.settings.poProjectOrder)) {
    plugin.data.settings.poProjectOrder = [];
  }
  if (!Array.isArray(plugin.data.settings.poTaskOrder)) {
    plugin.data.settings.poTaskOrder = [];
  }
  if (!Array.isArray(plugin.data.settings.mobileHiddenModules)) {
    plugin.data.settings.mobileHiddenModules = ["todo", "weekly", "projects", "countdown"];
  }
  // 对齐当前默认：本应默认在移动端显示、且用户仍在主页保留的模块，
  // 不应残留在 mobileHiddenModules（旧数据/手动误隐藏会导致移动端整卡消失，如每日口语）。
  // 仅清理「默认可见且仍在 homeModuleOrder」的模块，不动用户真正想隐藏的 todo/progress 等。
  {
    const mobileVisibleByDefault = ["qc", "dailyPhrase", "recent"];
    const order = plugin.data.settings.homeModuleOrder ?? [];
    plugin.data.settings.mobileHiddenModules = plugin.data.settings.mobileHiddenModules.filter(
      (id) => !(mobileVisibleByDefault.includes(id) && order.includes(id))
    );
  }
  } catch (err) {
    // 防御性补全失败不应阻止后续渲染；已用 structuredClone 兜底（见 loadPluginData）
    console.error("[Astra] Settings defensive completion failed", err);
  }

  const sections: SettingsSection[] = [
    {
      id: "dashboard",
      label: "Astra",
      icon: "layout-dashboard",
    },
    {
      id: "markdown",
      label: "Markdown+",
      icon: "file-text",
    },
    {
      id: "search",
      label: "Vault Search",
      icon: "search",
    },
    {
      id: "sync",
      label: "Vault Sync",
      icon: "cloud",
    },
  ];

  const navEl = container.createDiv({ cls: "astra-settings-nav" });
  const contentEl = container.createDiv({ cls: "astra-settings-content" });
  const sectionEls = new Map<string, HTMLElement>();
  const navButtons = new Map<string, HTMLButtonElement>();

  const setActiveSection = (sectionId: string) => {
    // 记录到模块级：renderSettings 重建 DOM（如同步页 rerender）后恢复所在 tab，
    // 否则会回落到第一个 tab
    settingsActiveSectionId = sectionId;
    sectionEls.forEach((sectionEl, id) => {
      sectionEl.toggleClass("is-active", id === sectionId);
    });
    navButtons.forEach((button, id) => {
      button.toggleClass("is-active", id === sectionId);
    });
  };

  sections.forEach((section) => {
    const button = navEl.createEl("button", {
      cls: "astra-settings-nav-btn",
      attr: { type: "button" },
    });
    const iconEl = button.createSpan({ cls: "astra-settings-nav-icon" });
    setIcon(iconEl, section.icon);
    button.createSpan({ text: section.label });
    button.addEventListener("click", () => setActiveSection(section.id));
    navButtons.set(section.id, button);

    const sectionEl = contentEl.createDiv({ cls: "astra-settings-section" });
    sectionEls.set(section.id, sectionEl);
  });

  // 恢复上次的激活 tab（首次打开默认第一个）
  setActiveSection(
    sections.some((section) => section.id === settingsActiveSectionId)
      ? settingsActiveSectionId
      : (sections[0]?.id ?? "dashboard")
  );

  // ===================== Dashboard =====================
  const dashboardEl = sectionEls.get("dashboard")!;
  try {

  // ── 通用 ──
  const generalGroup = new SettingGroup(dashboardEl).setHeading($t("p4.10064"));

  generalGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10068"))
      .setDesc($t("p4.10069"))
      .addToggle((toggle) =>
        toggle
          .setValue(plugin.data.settings.openOnStartup)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.openOnStartup = value;
              await plugin.saveSettings();
            })();
          })
      );
  });

  generalGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10070"))
      .setDesc($t("p4.10071"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("replace-active", $t("p4.10072"))
          .addOption("new-tab", $t("p4.10073"))
          .setValue(plugin.data.settings.startupMode)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.startupMode = value as StartupMode;
              await plugin.saveSettings();
            })();
          })
      );
  });

  generalGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10065"))
      .setDesc($t("p4.10066"))
      .addText((text) =>
        text
          .setPlaceholder($t("p4.10067"))
          .setValue(plugin.data.settings.displayName)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.displayName = value.trim();
              await plugin.saveSettings();
            })();
          })
      );
  });

  generalGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10074"))
      .setDesc($t("p4.10075"))
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 5)
          .setValue(plugin.data.settings.shortNoteWordThreshold)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.shortNoteWordThreshold = value;
              await plugin.saveSettings();
            })();
          })
      );
  });

  generalGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10076"))
      .setDesc($t("p4.10077"))
      .addTextArea((text) => {
        text
          .setPlaceholder($t("p4.10078"))
          .setValue(plugin.data.settings.excludedFolders.join("\n"))
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.excludedFolders = parseExcludedFolders(value);
              await plugin.saveSettings();
            })();
          });
        text.inputEl.rows = 4;
      });
  });

  // ── 主页模块 ──
  const modulesGroup = new SettingGroup(dashboardEl).setHeading($t("p4.10079"));

  modulesGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10080"))
      .setDesc($t("p4.10081"))
      .addText((text) => {
        text
          .setPlaceholder("Projects")
          .setValue(plugin.data.settings.projectsFolder)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.projectsFolder = value.trim();
              await plugin.saveSettings();
            })();
          });
        // 输入时联想库内文件夹，选中后回填相对路径（学习 Obsidian 官方「附件文件夹路径」交互）
        new ProjectFolderSuggest(plugin.app, text.inputEl, (path) => {
          plugin.data.settings.projectsFolder = path;
          void plugin.saveSettings();
        });
      });
  });

  modulesGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10082"))
      .setDesc($t("p4.10083"))
      .addText((text) =>
        text
          .setPlaceholder($t("p4.10084"))
          .setValue(plugin.data.settings.todoSourceFolder)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.todoSourceFolder = value.trim();
              await plugin.saveSettings();
            })();
          })
      );
  });

  modulesGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10085"))
      .setDesc($t("p4.10086"))
      .addText((text) =>
        text
          .setPlaceholder("Charter,PDCP,TR,ADCP,COR")
          .setValue(plugin.data.settings.npdpStages.join(","))
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.npdpStages = value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              await plugin.saveSettings();
            })();
          })
      );
  });

  modulesGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10087"))
      .setDesc($t("p4.10088"))
      .addSlider((slider) =>
        slider
          .setLimits(1, Math.max(1, plugin.data.settings.npdpStages.length), 1)
          .setValue(
            Math.min(plugin.data.settings.npdpProgressFilter, plugin.data.settings.npdpStages.length)
          )
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.npdpProgressFilter = value;
              await plugin.saveSettings();
            })();
          })
      );
  });

  modulesGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10089"))
      .setDesc($t("p4.10090"))
      .addText((text) => {
        text
          .setPlaceholder($t("p4.10091"))
          .setValue(plugin.data.settings.quickCapture.filePath)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.quickCapture.filePath = value.trim();
              await plugin.saveSettings();
            })();
          });
        // 输入时联想库内 md 笔记，选中后回填路径（与「项目文件夹」的交互一致，替换原「选择」弹窗按钮）
        new ProjectFileSuggest(plugin.app, text.inputEl, (path) => {
          plugin.data.settings.quickCapture.filePath = path;
          void plugin.saveSettings();
        });
      });
  });

  modulesGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10092"))
      .setDesc($t("p4.10093"))
      .addText((text) => {
        text
          .setPlaceholder($t("p4.10094"))
          .setValue(plugin.data.settings.dailyPhrase.filePath)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.dailyPhrase.filePath = value.trim();
              await plugin.saveSettings();
            })();
          });
        new ProjectFileSuggest(plugin.app, text.inputEl, (path) => {
          plugin.data.settings.dailyPhrase.filePath = path;
          void plugin.saveSettings();
        });
      });
  });

  // ── 日历 ──
  const calendarGroup = new SettingGroup(dashboardEl).setHeading($t("set.remaining.757"));

  calendarGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10097"))
      .setDesc($t("p4.10098"))
      .addDropdown((dd) => {
        dd.addOption("left", $t("p4.10099"));
        dd.addOption("right", $t("p4.10100"));
        dd.setValue(plugin.data.settings.calendar.position);
        dd.onChange((value) => {
          void (async () => {
            plugin.data.settings.calendar.position = value as "left" | "right";
            await plugin.saveSettings();
          })();
        });
      });
  });

  calendarGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10101"))
      .setDesc($t("p4.10102"))
      .addToggle((toggle) =>
        toggle
          .setValue(plugin.data.settings.calendar.shouldConfirmBeforeCreate)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.calendar.shouldConfirmBeforeCreate = value;
              await plugin.saveSettings();
            })();
          })
      );
  });

  // ── 移动端组件 ──
  // 「显示设置项」开关：与 Minimal 主题同语义——开关常显，打开后下方 mobileHiddenModules
  // 勾选项才出现；关闭时收起，仅保留开关本身。默认关闭。
  const mobileSettingEls: HTMLElement[] = [];
  const applyMobileVisibility = (): void => {
    const show = plugin.data.settings.mobileShowSettings === true;
    for (const el of mobileSettingEls) {
      el.style.display = show ? "" : "none";
    }
  };

  const mobileGroup = new SettingGroup(dashboardEl).setHeading($t("p4.10095"));
  mobileGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10261"))
      .setDesc($t("p4.10264"))
      .addToggle((toggle) => {
        toggle
          .setValue(plugin.data.settings.mobileShowSettings)
          .onChange((show) => {
            void (async () => {
              plugin.data.settings.mobileShowSettings = show;
              await plugin.saveSettings();
              applyMobileVisibility();
            })();
          });
      });
  });

  const moduleLabels: Record<string, string> = {
    qc: $t("mod.qc"),
    dailyPhrase: $t("mod.dailyPhrase"),
    todo: "TODO",
    weekly: $t("mod.weekly"),
    projects: $t("mod.projects"),
    countdown: $t("mod.countdown"),
    recent: $t("mod.recent")
  };
  for (const id of Object.keys(moduleLabels)) {
    mobileGroup.addSetting((setting) => {
      setting
        .setName(moduleLabels[id]!)
        .setDesc($t("p4.10265"))
        .addToggle((toggle) => {
          const hidden = plugin.data.settings.mobileHiddenModules;
          toggle.setValue(!hidden.includes(id));
          toggle.onChange((value) => {
            void (async () => {
              const arr = plugin.data.settings.mobileHiddenModules;
              const idx = arr.indexOf(id);
              if (value && idx >= 0) {
                arr.splice(idx, 1);
              } else if (!value && idx < 0) {
                arr.push(id);
              }
              await plugin.saveSettings();
            })();
          });
        });
      mobileSettingEls.push(setting.settingEl);
    });
  }
  // 初始态：所有 setting 创建完成后统一应用
  applyMobileVisibility();

  // ── Minimal 主题（移植自 obsidian-minimal-settings，独立 JSON 存储） ──
  renderMinimalSettings(dashboardEl, plugin);
  } catch (err) {
    dashboardEl.createDiv({ text: $t("set.groupLoadFail"), cls: "astra-empty-state" });
    console.error("[Astra] Settings tab 'dashboard' failed to render", err);
  }

  // ===================== Markdown+ =====================
  const markdownEl = sectionEls.get("markdown")!;
  try {

  // ── 视图（存储于 Section2 的 static-data.json，经 StaticStore） ──
  const store = plugin.section2Store;
  const fv = store.settings.forceViewMode;
  const forceViewGroup = new SettingGroup(markdownEl).setHeading($t("p4.10103"));

  // 启用光标位置（组内第 1）
  forceViewGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10110"))
      .setDesc($t("p4.10111"))
      .addToggle((toggle) =>
        toggle
          .setValue(plugin.data.settings.cursorPosition.enabled)
          .onChange((value) => {
            void (async () => {
              plugin.data.settings.cursorPosition.enabled = value;
              await plugin.saveSettings();
            })();
          })
      );
  });

  forceViewGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10104"))
      .setDesc($t("p4.10105"))
      .addToggle((toggle) =>
        toggle
          .setValue(fv.enabled)
          .onChange((value) => {
            void (async () => {
              fv.enabled = value;
              await store.save();
            })();
          })
      );
  });

  forceViewGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10106"))
      .setDesc($t("p4.10107"))
      .addToggle((toggle) =>
        toggle
          .setValue(fv.ignoreOpenFiles)
          .onChange((value) => {
            void (async () => {
              fv.ignoreOpenFiles = value;
              await store.save();
            })();
          })
      );
  });

  forceViewGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10108"))
      .setDesc($t("p4.10109"))
      .addToggle((toggle) =>
        toggle
          .setValue(fv.ignoreForceViewAll)
          .onChange((value) => {
            void (async () => {
              fv.ignoreForceViewAll = value;
              await store.save();
            })();
          })
      );
  });

  const forceViewModes = [
    "default",
    "obsidianUIMode: preview",
    "obsidianUIMode: source",
    "obsidianEditingMode: live",
    "obsidianEditingMode: source",
  ];

  /**
   * 增量渲染一条视图模式规则行（文件夹/文件规则共用）。
   * 添加/删除只操作单行 DOM，不做整页重渲染，避免滚动位置跳回设置页顶部。
   */
  const addRuleRow = <T extends { viewMode: string }>(params: {
    rules: T[];
    rule: T;
    placeholder: string;
    getPattern: () => string;
    setPattern: (value: string) => void;
    /** 新行插到该元素之前（文件夹规则行插到「文件规则」标题前），缺省追加到分组末尾 */
    before?: HTMLElement;
  }): void => {
    let rowSetting: Setting | undefined;
    forceViewGroup.addSetting((setting) => {
      rowSetting = setting;
      const rule = params.rule;
      setting
        .addText((text) => {
          text
            .setPlaceholder(params.placeholder)
            .setValue(params.getPattern())
            .onChange((value) => {
              void (async () => {
                params.setPattern(value);
                await store.save();
              })();
            });
        })
        .addDropdown((dd) => {
          forceViewModes.forEach((mode) => {
            dd.addOption(mode, mode);
          });
          dd.setValue(rule.viewMode || "default").onChange((value) => {
            void (async () => {
              rule.viewMode = value;
              await store.save();
            })();
          });
        })
        .addExtraButton((btn) =>
          btn
            .setIcon("cross")
            .setTooltip($t("set.remaining.758"))
            .onClick(() => {
              void (async () => {
                const index = params.rules.indexOf(rule);
                if (index !== -1) {
                  params.rules.splice(index, 1);
                  await store.save();
                }
                rowSetting?.settingEl.remove();
              })();
            })
        );
    });
    if (params.before && rowSetting) {
      params.before.before(rowSetting.settingEl);
    }
  };

  // 文件夹规则
  forceViewGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10112"))
      .setDesc($t("p4.10113"))
      .addButton((button) =>
        button
          .setButtonText("+")
          .setCta()
          .setTooltip($t("p4.10114"))
          .onClick(() => {
            void (async () => {
              const rule = { folder: "", viewMode: "" };
              fv.folders.push(rule);
              await store.save();
              addRuleRow({
                rules: fv.folders,
                rule,
                placeholder: $t("p4.10115"),
                getPattern: () => rule.folder,
                setPattern: (value) => {
                  rule.folder = value;
                },
                before: fileRulesHeaderEl,
              });
            })();
          })
      );
  });

  fv.folders.forEach((rule) => {
    addRuleRow({
      rules: fv.folders,
      rule,
      placeholder: $t("p4.10115"),
      getPattern: () => rule.folder,
      setPattern: (value) => {
        rule.folder = value;
      },
    });
  });

  // 文件规则
  let fileRulesHeaderEl: HTMLElement | undefined;
  forceViewGroup.addSetting((setting) => {
    fileRulesHeaderEl = setting.settingEl;
    setting
      .setName($t("p4.10116"))
      .setDesc($t("set.fileRules.desc"))
      .addButton((button) =>
        button
          .setButtonText("+")
          .setCta()
          .setTooltip($t("p4.10118"))
          .onClick(() => {
            void (async () => {
              const rule = { filePattern: "", viewMode: "" };
              fv.files.push(rule);
              await store.save();
              addRuleRow({
                rules: fv.files,
                rule,
                placeholder: $t("p4.10260"),
                getPattern: () => rule.filePattern,
                setPattern: (value) => {
                  rule.filePattern = value;
                },
              });
            })();
          })
      );
  });

  fv.files.forEach((rule) => {
    addRuleRow({
      rules: fv.files,
      rule,
      placeholder: $t("p4.10260"),
      getPattern: () => rule.filePattern,
      setPattern: (value) => {
        rule.filePattern = value;
      },
    });
  });

  // ── Linter（移植自 obsidian-linter，独立 JSON 存储） ──
  renderLinterSettings(markdownEl, plugin);
  } catch (err) {
    markdownEl.createDiv({ text: $t("set.groupLoadFail"), cls: "astra-empty-state" });
    console.error("[Astra] Settings tab 'markdown' failed to render", err);
  }

  // ===================== Vault Search =====================
  const searchEl = sectionEls.get("search")!;
  try {
  renderSearchSettings(searchEl, plugin);
  } catch (err) {
    searchEl.createDiv({ text: $t("set.groupLoadFail"), cls: "astra-empty-state" });
    console.error("[Astra] Settings tab 'search' failed to render", err);
  }

  // ===================== OneDrive Sync =====================
  const syncEl = sectionEls.get("sync")!;
  try {
  renderSyncSettings(syncEl, plugin, () => renderSettings(container, plugin));
  } catch (err) {
    syncEl.createDiv({ text: $t("set.groupLoadFail"), cls: "astra-empty-state" });
    console.error("[Astra] Settings tab 'sync' failed to render", err);
  }

}

/* ======================= Vault Search（omnisearch 精简版：仅保留常用项，冷门项固定默认值） ======================= */

/** 需要全量重建索引的设置（分词/索引范围类）；权重与查询行为实时生效 */
const needsRebuild = (key: string): boolean =>
  [
    "tokenizeUrls",
    "ignoreDiacritics",
    "indexedFileTypes",
    "indexFilesWithoutExtension",
    "unsupportedFilesIndexing",
    "displayTitle",
    "hideExcluded"
  ].includes(key);

function renderSearchSettings(searchEl: HTMLElement, plugin: AstraDashboardPlugin): void {
  const s = plugin.data.settings.search;

  /** 更新设置；索引范围/分词类变更触发全量重建 */
  const update = async (key: keyof SearchSettings, value: unknown): Promise<void> => {
    Object.assign(s, { [key]: value });
    await plugin.saveSettings();
    if (needsRebuild(key)) await plugin.searchService.rebuild();
  };

  const toggleSetter =
    (key: keyof SearchSettings) =>
    (value: boolean): void => {
      void update(key, value);
    };

  const group = new SettingGroup(searchEl);
  group.addSetting((setting) => {
    setting
      .setName($t("search.set.hideExcluded.name"))
      .setDesc($t("search.set.hideExcluded.desc"))
      .addToggle((toggle) => toggle.setValue(s.hideExcluded).onChange(toggleSetter("hideExcluded")));
  });
  group.addSetting((setting) => {
    setting
      .setName($t("search.set.highlight.name"))
      .setDesc($t("search.set.highlight.desc"))
      .addToggle((toggle) => toggle.setValue(s.highlight).onChange(toggleSetter("highlight")));
  });
  group.addSetting((setting) => {
    setting
      .setName($t("search.set.excerpt.name"))
      .setDesc($t("search.set.excerpt.desc"))
      .addToggle((toggle) => toggle.setValue(s.showExcerpt).onChange(toggleSetter("showExcerpt")));
  });
  group.addSetting((setting) => {
    setting
      .setName($t("search.set.prevQuery.name"))
      .setDesc($t("search.set.prevQuery.desc"))
      .addToggle((toggle) => toggle.setValue(s.showPreviousQueryResults).onChange(toggleSetter("showPreviousQueryResults")));
  });
  group.addSetting((setting) => {
    setting
      .setName($t("search.set.scrollToMatch.name"))
      .setDesc($t("search.set.scrollToMatch.desc"))
      .addToggle((toggle) => toggle.setValue(s.scrollToMatch).onChange(toggleSetter("scrollToMatch")));
  });
  group.addSetting((setting) => {
    setting
      .setName($t("search.set.simple.name"))
      .setDesc($t("search.set.simple.desc"))
      .addToggle((toggle) => toggle.setValue(s.simpleSearch).onChange(toggleSetter("simpleSearch")));
  });
  group.addSetting((setting) => {
    setting
      .setName($t("search.set.fuzziness.name"))
      .setDesc($t("search.set.fuzziness.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            "0": $t("search.opt.exact"),
            "1": $t("search.opt.notTooFuzzy"),
            "2": $t("search.opt.fuzzyEnough")
          })
          .setValue(s.fuzziness)
          .onChange((v) => void update("fuzziness", v))
      );
  });
}

function parseExcludedFolders(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((path) => normalizePath(path.trim()))
    .filter(Boolean);
}

/* ============================ OneDrive Sync ============================ */

/** 设置页当前激活 tab（renderSettings 重建 DOM 后恢复，避免跳回第一个 tab） */
let settingsActiveSectionId = "dashboard";

/** 多行描述：按 \n 拆分为带换行的 DocumentFragment（上游用 createFragment 分行） */
const syncMultilineDesc = (text: string): DocumentFragment => {
  const frag = createFragment();
  const lines = text.split("\n");
  lines.forEach((part, i) => {
    if (i > 0) {
      frag.appendChild(createEl("br"));
    }
    frag.appendText(part);
  });
  return frag;
};

/** 修改密码确认（复刻上游 PasswordModal：修改会使既有加密文件失效的多点警示） */
class SyncPasswordModal extends Modal {
  constructor(
    app: App,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: $t("modal_password_title") });
    for (const key of [
      "modal_password_shortdesc",
      "modal_password_attn1",
      "modal_password_attn2",
      "modal_password_attn3",
      "modal_password_attn4",
      "modal_password_attn5",
    ]) {
      contentEl.createEl("p", { text: $t(key) });
    }
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText($t("settings_cancel")).onClick(() => this.close())
      )
      .addButton((b) =>
        b
          .setButtonText($t("settings_confirm"))
          .setCta()
          .onClick(() => {
            void (async () => {
              await this.onConfirm();
              this.close();
            })();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 同步 .obsidian 配置文件夹的二次确认（复刻上游 SyncConfigDirModal） */
class SyncConfigDirConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", {
      text: $t("settings_configdir"),
    });
    for (const key of ["modal_syncconfig_attn", "modal_syncconfig_secondconfirm"]) {
      contentEl.createEl("p", { text: $t(key) });
    }
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText($t("modal_syncconfig_notice"))
          .setWarning()
          .onClick(() => {
            void (async () => {
              await this.onConfirm();
              this.close();
            })();
          })
      )
      .addButton((b) =>
        b.setButtonText($t("settings_cancel")).onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function renderSyncSettings(
  syncEl: HTMLElement,
  plugin: AstraDashboardPlugin,
  rerender: () => void
): void {
  const s = plugin.data.settings.sync;
  const syncManager = plugin.syncManager;

  // 授权状态变化（OAuth 回调成功 / 撤回）时由 syncManager 通知本页整页重渲染；
  // 设置页关闭时在 AstraSettingTab.hide() 中解除注册
  syncManager.registerSettingsRerender(rerender);

  // ── 账户（上游「OneDrive（个人版）（App Folder）设置」）──
  const statusGroup = new SettingGroup(syncEl).setHeading(
    $t("settings_onedrive")
  );

  // 鉴权 / 撤回鉴权（上游按连接状态互斥显示）
  if (syncManager.isAuthorized) {
    statusGroup.addSetting((setting) => {
      setting
        .setName($t("settings_onedrive_revoke"))
        .setDesc(
          $t("settings_onedrive_revoke_desc", {
            username: s.onedriveConfig.username,
          })
        );
      setting.addButton((btn) =>
        btn
          .setButtonText($t("settings_onedrive_revoke_button"))
          .setWarning()
          .onClick(() => {
            void (async () => {
              await syncManager.revokeAuth();
              rerender();
            })();
          })
      );
    });
  } else {
    statusGroup.addSetting((setting) => {
      setting
        .setName($t("settings_onedrive_auth"))
        .setDesc($t("settings_onedrive_auth_desc"));
      setting.addButton((btn) =>
        btn
          .setButtonText($t("settings_onedrive_auth_button"))
          .setCta()
          .onClick(() => void syncManager.startAuth())
      );
    });
  }

  // 检查可否连接（上游 settings_checkonnectivity）
  statusGroup.addSetting((setting) => {
    setting
      .setName($t("sync.action.checkConn"))
      .setDesc($t("sync.action.checkConnDesc"));
    setting.addButton((btn) =>
      btn
        .setButtonText($t("sync.action.checkConnButton"))
        .onClick(() => void syncManager.checkConnection())
    );
  });

  // 当前状态（移植自上游 settings_status_summary）
  statusGroup.addSetting((setting) => {
    setting
      .setName($t("settings_status_summary"))
      .setDesc(
        $t("settings_status_summary_desc", {
          service: "OneDrive",
          direction: $t(`syncdirection_short_${s.syncDirection}`),
          encryption: s.password
            ? $t("settings_status_encrypted")
            : $t("settings_status_notencrypted"),
          lastsynced:
            s.lastSynced > 0
              ? (unixTimeToStr(s.lastSynced, "YYYY-MM-DD HH:mm:ss") ?? "—")
              : $t("settings_status_neversynced"),
        })
      );
  });

  // ── 通用 ──
  const basicGroup = new SettingGroup(syncEl).setHeading($t("settings_basic"));

  // 密码（上游语义：空 = 不加密；确认修改走 PasswordModal）
  let newPassword = `${s.password}`;
  basicGroup.addSetting((setting) => {
    setting
      .setName($t("settings_password"))
      .setDesc($t("settings_password_desc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(newPassword).onChange((value) => {
          newPassword = value.trim();
        });
      })
      .addButton((button) =>
        button.setButtonText($t("settings_confirm")).onClick(() => {
          if (newPassword === s.password) {
            return;
          }
          new SyncPasswordModal(plugin.app, async () => {
            s.password = newPassword;
            await plugin.saveSettings();
          }).open();
        })
      );
  });

  // 同步方向（3 种；控件移到描述之后）
  let directionSetting: Setting | null = null;
  basicGroup.addSetting((setting) => {
    directionSetting = setting;
    setting
      .setName($t("setting_syncdirection"))
      .setDesc(syncMultilineDesc($t("setting_syncdirection_desc")))
      .addDropdown((dropdown) =>
        dropdown
          .addOption(
            "bidirectional",
            $t("setting_syncdirection_bidirectional_desc")
          )
          .addOption(
            "incremental_push_and_delete_only",
            $t("setting_syncdirection_incremental_push_and_delete_only_desc")
          )
          .addOption(
            "incremental_pull_and_delete_only",
            $t("setting_syncdirection_incremental_pull_and_delete_only_desc")
          )
          .setValue(s.syncDirection)
          .onChange((value) => {
            void (async () => {
              s.syncDirection = value as SyncDirectionType;
              await plugin.saveSettings();
            })();
          })
      );
  });
  if (directionSetting !== null) {
    const dse = directionSetting as Setting;
    dse.settingEl.appendChild(dse.controlEl);
  }

  // 自动同步（单一下拉四档，含启动首次固定 5s 延迟 + 周期运行）
  basicGroup.addSetting((setting) => {
    setting
      .setName($t("settings_autorun"))
      .setDesc($t("settings_autorun_desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("-1", $t("settings_autorun_notset"))
          .addOption("300000", $t("settings_autorun_5min"))
          .addOption("600000", $t("settings_autorun_10min"))
          .addOption("1800000", $t("settings_autorun_30min"))
          .setValue(`${s.autoRunEveryMilliseconds}`)
          .onChange((value) => {
            void (async () => {
              s.autoRunEveryMilliseconds = parseInt(value);
              await plugin.saveSettings();
              syncManager.applyEnabled();
            })();
          })
      );
  });

  // 保存后同步延迟（独立布尔开关；固定 5s trailing debounce，不可调；两次自动同步间最小 30s 间隔）
  basicGroup.addSetting((setting) => {
    setting
      .setName($t("settings_syncOnSave"))
      .setDesc($t("settings_syncOnSave_desc"))
      .addToggle((toggle) =>
        toggle.setValue(s.syncOnSaveEnabled).onChange((value) => {
          void (async () => {
            s.syncOnSaveEnabled = value;
            await plugin.saveSettings();
            syncManager.applyEnabled();
          })();
        })
      );
  });

  // ── 同步 ──
  const whatGroup = new SettingGroup(syncEl).setHeading(
    $t("settings_basic_what")
  );

  // 同步 _ 开头文件（组内第 1）
  whatGroup.addSetting((setting) => {
    setting
      .setName($t("settings_syncunderscore"))
      .setDesc($t("settings_syncunderscore_desc"))
      .addToggle((toggle) =>
        toggle.setValue(s.syncUnderscoreItems).onChange((value) => {
          void (async () => {
            s.syncUnderscoreItems = value;
            await plugin.saveSettings();
          })();
        })
      );
  });

  // 同步 .trash
  whatGroup.addSetting((setting) => {
    setting
      .setName($t("settings_sync_trash"))
      .setDesc($t("settings_sync_trash_desc"))
      .addToggle((toggle) =>
        toggle.setValue(s.syncTrash).onChange((value) => {
          void (async () => {
            s.syncTrash = value;
            await plugin.saveSettings();
          })();
        })
      );
  });

  // 同步书签
  whatGroup.addSetting((setting) => {
    setting
      .setName($t("settings_sync_bookmarks"))
      .setDesc($t("settings_sync_bookmarks_desc"))
      .addToggle((toggle) =>
        toggle.setValue(s.syncBookmarks).onChange((value) => {
          void (async () => {
            s.syncBookmarks = value;
            await plugin.saveSettings();
          })();
        })
      );
  });

  // 同步配置文件夹（开 → 二次确认）
  whatGroup.addSetting((setting) => {
    setting
      .setName($t("settings_configdir"))
      .setDesc(
        $t("settings_configdir_desc", {
          configDir: plugin.app.vault.configDir,
        })
      )
      .addToggle((toggle) =>
        toggle.setValue(s.syncConfigDir).onChange((value) => {
          if (value && !s.syncConfigDir) {
            toggle.setValue(false);
            new SyncConfigDirConfirmModal(plugin.app, async () => {
              s.syncConfigDir = true;
              await plugin.saveSettings();
              toggle.setValue(true);
            }).open();
            return;
          }
          void (async () => {
            s.syncConfigDir = false;
            await plugin.saveSettings();
          })();
        })
      );
  });

  // ── 高级 ──
  const advGroup = new SettingGroup(syncEl).setHeading($t("settings_adv"));

  // 跳过大文件
  advGroup.addSetting((setting) => {
    setting
      .setName($t("settings_skiplargefiles"))
      .setDesc($t("settings_skiplargefiles_desc"))
      .addDropdown((dropdown) => {
        const options: [string, string][] = [
          ["-1", $t("settings_skiplargefiles_notset")],
          ["1000000", "1MB"],
          ["2000000", "2MB"],
          ["5000000", "5MB"],
          ["10000000", "10MB"],
          ["50000000", "50MB"],
          ["100000000", "100MB"],
          ["500000000", "500MB"],
          ["1000000000", "1000MB"],
        ];
        for (const [value, label] of options) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(`${s.skipSizeLargerThan}`)
          .onChange((value) => {
            void (async () => {
              s.skipSizeLargerThan = parseInt(value);
              await plugin.saveSettings();
            })();
          });
      });
  });

  // 删除文件到哪里
  advGroup.addSetting((setting) => {
    setting
      .setName($t("settings_deletetowhere"))
      .setDesc($t("settings_deletetowhere_desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("system_trash", $t("settings_deletetowhere_system_trash"))
          .addOption(
            "obsidian_trash",
            $t("settings_deletetowhere_obsidian_trash")
          )
          .setValue(s.deleteToWhere)
          .onChange((value) => {
            void (async () => {
              s.deleteToWhere = value as DeleteToWhereType;
              await plugin.saveSettings();
            })();
          })
      );
  });

  // 处理冲突
  advGroup.addSetting((setting) => {
    setting
      .setName($t("settings_conflictaction"))
      .setDesc($t("settings_conflictaction_desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("keep_newer", $t("settings_conflictaction_keep_newer"))
          .addOption("keep_larger", $t("settings_conflictaction_keep_larger"))
          .setValue(s.conflictAction)
          .onChange((value) => {
            void (async () => {
              s.conflictAction = value as ConflictActionType;
              await plugin.saveSettings();
            })();
          })
      );
  });

  // 清空本地同步状态（astra 附加）
  advGroup.addSetting((setting) => {
    setting
      .setName($t("sync.action.clearLocal"))
      .setDesc($t("sync.action.clearLocalDesc"))
      .addButton((btn) =>
        btn
          .setButtonText($t("sync.action.clearLocalButton"))
          .setWarning()
          .onClick(() => void syncManager.clearLocalSyncData())
      );
  });
}

/* ============================ Minimal 主题 ============================ */

type MinimalStringKey =
  | "lightScheme"
  | "lightStyle"
  | "darkScheme"
  | "darkStyle"
  | "tableWidth"
  | "imgWidth"
  | "iframeWidth"
  | "mapWidth"
  | "chartWidth";
function renderMinimalSettings(
  container: HTMLElement,
  plugin: AstraDashboardPlugin
): void {
  const manager = plugin.minimalManager;
  if (!manager) return;

  const applyFor = (key: MinimalStringKey) => {
    switch (key) {
      case "lightScheme":
        return manager.updateLightScheme();
      case "lightStyle":
        return manager.updateLightStyle();
      case "darkScheme":
        return manager.updateDarkScheme();
      case "darkStyle":
        return manager.updateDarkStyle();
      default:
        return manager.refresh();
    }
  };

  const save = async () => {
    await manager.saveSettings();
  };

  // 「显示设置项」开关：开关常显，组内其余设置项默认隐藏，打开后才显示。
  const minimalSettingEls: HTMLElement[] = [];
  const applyMinimalVisibility = (): void => {
    const show = manager.settings.showSettings === true;
    for (const el of minimalSettingEls) {
      el.style.display = show ? "" : "none";
    }
  };

  // ── Color scheme ──
  const colorGroup = new SettingGroup(container).setHeading($t("p4.10119"));
  colorGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10261"))
      .setDesc($t("p4.10262"))
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.showSettings)
          .onChange((value) => {
            void (async () => {
              manager.settings.showSettings = value;
              await save();
              applyMinimalVisibility();
            })();
          })
      );
  });
  colorGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10120"))
      .setDesc($t("p4.10121"))
      .addDropdown((dd) => {
        lightSchemeOptions.forEach(({ value, label }) => {
          dd.addOption(value, label);
        });
        dd.setValue(manager.settings.lightScheme);
        dd.onChange((value) => {
          void (async () => {
            manager.settings.lightScheme = value;
            await save();
            applyFor("lightScheme");
          })();
        });
      });
    minimalSettingEls.push(setting.settingEl);
  });
  colorGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10122"))
      .setDesc($t("p4.10123"))
      .addDropdown((dd) => {
        darkSchemeOptions.forEach(({ value, label }) => {
          dd.addOption(value, label);
        });
        dd.setValue(manager.settings.darkScheme);
        dd.onChange((value) => {
          void (async () => {
            manager.settings.darkScheme = value;
            await save();
            applyFor("darkScheme");
          })();
        });
      });
    minimalSettingEls.push(setting.settingEl);
  });

  colorGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10126"))
      .setDesc($t("p4.10127"))
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.minimalStatus)
          .onChange((value) => {
            void (async () => {
              manager.settings.minimalStatus = value;
              await save();
              manager.refresh();
            })();
          })
      );
    minimalSettingEls.push(setting.settingEl);
  });
  colorGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10124"))
      .setDesc($t("p4.10125"))
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.imgGrid)
          .onChange((value) => {
            void (async () => {
              manager.settings.imgGrid = value;
              await save();
              manager.refresh();
            })();
          })
      );
    minimalSettingEls.push(setting.settingEl);
  });
  colorGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10128"))
      .setDesc($t("p4.10129"))
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.focusMode)
          .onChange((value) => {
            void (async () => {
              manager.settings.focusMode = value;
              await save();
              manager.refresh();
            })();
          })
      );
    minimalSettingEls.push(setting.settingEl);
  });
  applyMinimalVisibility();
}

/* ============================ Linter ============================ */

function renderLinterSettings(
  container: HTMLElement,
  plugin: AstraDashboardPlugin
): void {
  const manager = plugin.linterManager;
  if (!manager) return;

  const save = async () => {
    await manager.saveSettings();
  };

  const linterGroup = new SettingGroup(container).setHeading("Linter Lite");

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10130"))
      .setDesc(
        (() => {
          const frag = createFragment();
          frag.append($t("set.formatOnSave.p1"));
          const k1 = createEl("code");
          k1.textContent = "Cmd/Ctrl+S";
          frag.append(k1);
          frag.append($t("set.formatOnSave.p2"));
          const k2 = createEl("code");
          k2.textContent = ":w";
          frag.append(k2);
          frag.append($t("set.formatOnSave.p3"));
          return frag;
        })()
      )
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.lintOnSave)
          .onChange((value) => {
            void (async () => {
              manager.settings.lintOnSave = value;
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10133"))
      .setDesc($t("p4.10134"))
      .addTextArea((text) => {
        text
          .setPlaceholder($t("p4.10078"))
          .setValue(manager.settings.foldersToIgnore.join("\n"))
          .onChange((value) => {
            void (async () => {
              manager.settings.foldersToIgnore = value
                .split(/\r?\n/u)
                .map((p) => normalizePath(p.trim()))
                .filter(Boolean);
              await save();
            })();
          });
        text.inputEl.rows = 4;
      });
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10135"))
      .setDesc($t("p4.10136"))
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.yamlTimestamp.enabled)
          .onChange((value) => {
            void (async () => {
              manager.settings.yamlTimestamp.enabled = value;
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10137"))
      .setDesc($t("p4.10138"))
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.yamlTimestamp.dateCreated)
          .onChange((value) => {
            void (async () => {
              manager.settings.yamlTimestamp.dateCreated = value;
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10139"))
      .setDesc($t("p4.10140"))
      .addText((text) =>
        text
          .setPlaceholder("date created")
          .setValue(manager.settings.yamlTimestamp.dateCreatedKey)
          .onChange((value) => {
            void (async () => {
              manager.settings.yamlTimestamp.dateCreatedKey = value;
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10141"))
      .setDesc($t("p4.10142"))
      .addDropdown((dd) =>
        dd
          .addOption("file system", $t("p4.10143"))
          .addOption("frontmatter", "YAML frontmatter")
          .setValue(manager.settings.yamlTimestamp.dateCreatedSourceOfTruth)
          .onChange((value) => {
            void (async () => {
              manager.settings.yamlTimestamp.dateCreatedSourceOfTruth = value as
                | "file system"
                | "frontmatter";
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10144"))
      .setDesc($t("p4.10145"))
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.yamlTimestamp.dateModified)
          .onChange((value) => {
            void (async () => {
              manager.settings.yamlTimestamp.dateModified = value;
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10146"))
      .setDesc($t("p4.10147"))
      .addText((text) =>
        text
          .setPlaceholder("date modified")
          .setValue(manager.settings.yamlTimestamp.dateModifiedKey)
          .onChange((value) => {
            void (async () => {
              manager.settings.yamlTimestamp.dateModifiedKey = value;
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10148"))
      .setDesc($t("p4.10149"))
      .addDropdown((dd) =>
        dd
          .addOption("file system", $t("p4.10143"))
          .addOption("user or Linter edits", $t("p4.10150"))
          .setValue(manager.settings.yamlTimestamp.dateModifiedSourceOfTruth)
          .onChange((value) => {
            void (async () => {
              manager.settings.yamlTimestamp.dateModifiedSourceOfTruth = value as
                | "file system"
                | "user or Linter edits";
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10151"))
      .setDesc(
        (() => {
          const frag = createFragment();
          frag.append($t("set.momentFormat.p1"));
          const a = createEl("a");
          a.href =
            "https://momentjscom.readthedocs.io/en/latest/moment/04-displaying/01-format/";
          a.textContent = $t("auto.342");
          a.target = "_blank";
          a.rel = "noopener";
          frag.append(a);
          frag.append($t("set.momentFormat.p2"));
          return frag;
        })()
      )
      .addText((text) =>
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(manager.settings.yamlTimestamp.format)
          .onChange((value) => {
            void (async () => {
              manager.settings.yamlTimestamp.format = value;
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10155"))
      .setDesc($t("p4.10156"))
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.twoSpaces.enabled)
          .onChange((value) => {
            void (async () => {
              manager.settings.twoSpaces.enabled = value;
              await save();
            })();
          })
      );
  });

  linterGroup.addSetting((setting) => {
    setting
      .setName($t("p4.10153"))
      .setDesc($t("p4.10154"))
      .addToggle((toggle) =>
        toggle
          .setValue(manager.settings.yamlTimestamp.convertToUTC)
          .onChange((value) => {
            void (async () => {
              manager.settings.yamlTimestamp.convertToUTC = value;
              await save();
            })();
          })
      );
  });
}