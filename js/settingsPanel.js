/* 设置页：表单字段与配置键的声明式映射、打开/保存、模型下拉、服务日志与重启。
   新增设置只需在 FIELDS 加一行（及 index.html 控件与 Config.DEFAULTS），打开与保存自动同步。 */
const SettingsPanel = (() => {
  const { $, toast } = Dom;
  // [控件 id, 配置键, 类型]；text 去首尾空白，number 空值为 NaN 交由 Config 校验报错，select/check 原样。
  const FIELDS = [
    ['cfg-project-root', 'projectRoot', 'text'],
    ['cfg-port', 'port', 'number'],
    ['cfg-model', 'modelName', 'select'],
    ['cfg-theme', 'theme', 'select'],
    ['cfg-thumb-cache-count', 'thumbnailCacheMaxEntries', 'number'],
    ['cfg-thumb-cache-mb', 'thumbnailCacheMaxMB', 'number'],
    ['cfg-visual-threshold', 'visualThreshold', 'number'],
    ['cfg-visual-margin', 'visualMargin', 'number'],
    ['cfg-visual-agg', 'visualAgg', 'select'],
    ['cfg-visual-centered', 'visualCentered', 'check'],
    ['cfg-visual-scene-frames', 'visualSceneFrames', 'number'],
    ['cfg-visual-video-frames', 'visualVideoFrames', 'number'],
    ['cfg-idx-sample-interval', 'indexSampleInterval', 'number'],
    ['cfg-idx-resolution', 'indexResolution', 'number'],
    ['cfg-idx-min-scene', 'indexMinSceneLen', 'number'],
    ['cfg-idx-batch', 'indexBatchSize', 'number'],
    ['cfg-idx-scene-threshold', 'indexSceneThreshold', 'number'],
    ['cfg-idx-localmax', 'indexLocalmaxOrder', 'number'],
    ['cfg-idx-frame-selection', 'indexFrameSelection', 'select'],
    ['cfg-idx-shot-detection', 'indexShotDetection', 'select'],
    ['cfg-idx-content-max', 'indexContentMaxFrames', 'number'],
    ['cfg-idx-fp16', 'indexFp16', 'check'],
    ['cfg-deepseek-key', 'deepseekKey', 'text'],
    ['cfg-ai-enhance', 'aiEnhance', 'check'],
    ['cfg-ai-expand', 'aiExpand', 'check'],
    ['cfg-ai-mode', 'aiMode', 'select'],
    ['cfg-ai-plan-preview', 'aiPlanPreview', 'check'],
    ['cfg-mini-rerank', 'miniRerank', 'check'],
    ['cfg-auto-check-new', 'autoCheckNew', 'check'],
    ['cfg-eval-mode', 'evalMode', 'check'],
    ['cfg-auto-index', 'autoIndex', 'check'],
  ];
  let hooks = {};

  function fill(cfg) {
    for (const [id, key, type] of FIELDS) {
      const value = cfg[key] ?? Config.DEFAULTS[key];
      if (type === 'check') $(id).checked = !!value;
      else $(id).value = value ?? '';
    }
  }

  function read() {
    return Object.fromEntries(FIELDS.map(([id, key, type]) => {
      const input = $(id);
      if (type === 'check') return [key, input.checked];
      if (type === 'number') return [key, input.value === '' ? NaN : Number(input.value)];
      if (type === 'text') return [key, input.value.trim()];
      return [key, input.value || Config.DEFAULTS[key]];
    }));
  }

  // 动态模型列表（模型升级通道：models/ 目录放入新模型即出现在下拉）
  async function populateModelSelect() {
    const select = $('cfg-model');
    try {
      const models = await Api.listModels();
      // 过滤掉非嵌入模型（重排/多模态大模型/工具目录）
      const embeddable = models.filter((m) => !/reranker|minicpm|ffmpeg|shot_scale|dinov3|transnet/i.test(m.name));
      if (embeddable.length === 0) return; // 保留静态选项
      const current = Config.get().modelName;
      select.innerHTML = '';
      embeddable.forEach((m) => {
        const option = document.createElement('option');
        option.value = m.name;
        option.textContent = m.name + (/fg-?clip2/i.test(m.name) ? '（中文，推荐）' : '');
        select.appendChild(option);
      });
      select.value = embeddable.some((m) => m.name === current) ? current : embeddable[0].name;
    } catch { /* 服务不在线时保留静态选项 */ }
  }

  function open() {
    populateModelSelect();
    fill(Config.get());
    $('settings-error').textContent = Config.getLoadError?.() || '';
    $('btn-recover-settings').classList.toggle('hidden', !Config.getLoadError?.());
    $('settings-dialog').showModal();
  }

  function save(event, recover = false) {
    event.preventDefault();
    $('settings-error').textContent = '';
    if (!$('settings-form').reportValidity()) return;
    try {
      const previous = Config.get();
      const values = read();
      const modelChanged = values.modelName !== previous.modelName;
      const suggested = values.modelName.includes('fg-clip2') ? 11 : 21;
      Config.save({ ...values, ...(modelChanged ? { threshold: suggested } : {}) }, { recover });
      hooks.applied();
      if (modelChanged) {
        $('threshold').value = suggested;
        $('threshold-val').textContent = suggested;
        toast(`已切换模型，阈值建议调整为 ${suggested}，请对库重新建索引`);
      }
      if (Config.get().deepseekKey !== (previous.deepseekKey || '')) {
        toast('DeepSeek Key 已更新，点击设置里的「重启搜索服务」后生效', false, 5000);
      }
      hooks.setServiceStatus('offline', '配置已更新，正在重新连接…');
      $('settings-dialog').close();
      Service.ensure(hooks.setServiceStatus);
    } catch (error) {
      $('settings-error').textContent = error.message;
    }
  }

  function viewServiceLog() {
    const logPath = Service.logPath();
    try {
      if (!require('fs').existsSync(logPath)) {
        toast('日志文件还不存在（服务由插件启动后才会产生日志）', true);
        return;
      }
      eagle.shell.openPath(logPath);
    } catch (error) {
      toast(`打开日志失败：${error.message}`, true);
    }
  }

  async function restartService() {
    $('settings-dialog').close();
    hooks.setServiceStatus('starting', '正在重启搜索服务…');
    try {
      const resp = await Api.shutdown();
      if (!resp.ok && resp.data && resp.data.error) {
        toast(resp.data.error, true);
        hooks.setServiceStatus('online', '搜索服务已连接');
        return;
      }
    } catch { /* 服务本来就没起来，直接走启动流程 */ }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    Service.ensure(hooks.setServiceStatus);
  }

  /* hooks: setServiceStatus(state, message)；applied() 在配置保存成功后应用主题/缓存/自动索引。 */
  function init(options) {
    hooks = options;
  }

  return { init, open, save, viewServiceLog, restartService, populateModelSelect, FIELDS };
})();
