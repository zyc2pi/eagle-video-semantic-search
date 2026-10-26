/* 配置持久化：<插件目录>/config.json */
const Config = (() => {
  const fs = require('fs');
  const path = require('path');

  const DEFAULTS = {
    projectRoot: 'D:\\Auto-scenes-extraction-1.3.0\\Auto-scenes-extraction-1.3.0',
    port: 5006,
    modelName: 'qihoo360-fg-clip2-base',
    thumbnailCacheMaxEntries: 5000,
    thumbnailCacheMaxMB: 128,
    threshold: 11,
    // 视觉检索（以图/以片搜）阈值：图像-图像相似度天然偏高，与文本阈值语义不同
    visualThreshold: 40,
    // 视觉检索相对落差：只保留与最高分差距在此范围内的结果，越小越严
    visualMargin: 15,
    // 视觉检索：场景聚合方式（mean=整个场景都要像/严格，max=一帧像即命中/宽松）
    visualAgg: 'mean',
    // 视觉检索：向量中心化（减去库平均画风，抑制"同画风即高分"；开启后忽略视觉阈值）
    visualCentered: false,
    // 视觉检索：查询采样帧数（片段查询 / 整视频查询）
    visualSceneFrames: 5,
    visualVideoFrames: 8,
    // ---- 建索引参数（改动只影响之后新索引的视频，已索引部分不受影响）----
    indexSampleInterval: 5,      // 每 N 帧取 1 帧，越小越精细越慢
    indexResolution: 256,        // 抽帧短边像素
    indexMinSceneLen: 7,         // 最小场景长度（帧），更短的场景会被合并
    indexBatchSize: 8,           // GPU 流水线批大小（FG-CLIP2 微批上限为 8）
    indexSceneThreshold: 0.85,   // 场景切分余弦阈值，越高切得越碎
    indexLocalmaxOrder: 2,       // 边界检测局部极小值阶数
    indexFrameSelection: 'content_adaptive', // 复用现有向量，自适应数量；仅影响新索引
    indexContentMaxFrames: 12,
    indexFp16: true,             // FP16 推理（仅 NVIDIA GPU 生效）
    // 搜索范围：all=整个库；selected=跟随 Eagle 选中；custom=指定；exclude=排除
    scopeMode: 'all',
    scopeFolderIds: [],          // custom/exclude 模式勾选的文件夹 id（递归展开子文件夹）
    scopeLibrary: '',            // 勾选时所在的库路径，换库后自动重置为 all
    // 静默自动索引：插件随 Eagle 后台运行时，定时检查新素材并自动增量索引
    autoIndex: false,
    // 最近一次已确认的索引结果，仅用于计算“本轮新跳过/失败”并提示一次。
    indexOutcomeLibrary: '',
    indexOutcomeSkipped: 0,
    indexOutcomeFailed: 0,
    deepseekKey: '',    // DeepSeek API key，注入服务进程环境供 AI 查询增强使用
    aiEnhance: false,   // AI 查询增强总开关：双语改写（需配置 DeepSeek key）
    aiExpand: false,    // AI 语义扩展：额外生成同义/场景变体查询（最多 8 条，多路合并）
    aiMode: 'balanced', // AI 查询增强档位 fast/balanced/quality（变体数量与质量权衡）
    dedup: false,       // 跨视频去重
    dedupThreshold: 0.95, // 去重相似度阈值：越低合并越激进
    miniRerank: false,  // MiniCPM 二阶段精搜（慢，占显存大）
    history: [],        // 最近搜索词
  };

  let configPath = null;
  let pluginDir = null;
  let current = { ...DEFAULTS };
  let loadError = '';
  let errorHandler = null;
  const NUMBER_RULES = {
    port: [1, 65535, true], threshold: [0, 120], visualThreshold: [0, 120],
    visualMargin: [1, 60], visualSceneFrames: [1, 16, true], visualVideoFrames: [1, 32, true],
    indexSampleInterval: [1, 30, true], indexResolution: [128, 512, true],
    indexMinSceneLen: [1, 120, true], indexBatchSize: [8, 128, true],
    indexSceneThreshold: [0.5, 0.99], indexLocalmaxOrder: [1, 5, true], dedupThreshold: [0.8, 0.99],
    indexContentMaxFrames: [1, 32, true],
    thumbnailCacheMaxEntries: [0, 50000, true], thumbnailCacheMaxMB: [0, 1024, true],
  };

  function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置格式无效');
    for (const [key, [min, max, integer]] of Object.entries(NUMBER_RULES)) {
      const n = value[key];
      if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
        throw new Error(`设置 ${key} 必须为 ${min}～${max} 范围内的${integer ? '整数' : '数值'}`);
      }
    }
    if (value.indexResolution % 32 || value.indexBatchSize % 8) throw new Error('分辨率须为 32 的倍数，批大小须为 8 的倍数');
    if (typeof value.projectRoot !== 'string' || !value.projectRoot.trim()
        || typeof value.modelName !== 'string' || !value.modelName.trim()) throw new Error('项目路径和模型不能为空');
    if (!['mean', 'max'].includes(value.visualAgg) || !['fast', 'balanced', 'quality'].includes(value.aiMode)
        || !['all', 'selected', 'custom', 'exclude'].includes(value.scopeMode)
        || !['triplet', 'dinov3_cses', 'content_adaptive'].includes(value.indexFrameSelection)) throw new Error('配置选项无效');
    if (!Array.isArray(value.history) || !value.history.every((v) => typeof v === 'string')
        || !Array.isArray(value.scopeFolderIds) || !value.scopeFolderIds.every((v) => typeof v === 'string')) throw new Error('配置列表格式无效');
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      if (typeof fallback === 'boolean' && typeof value[key] !== 'boolean') throw new Error(`设置 ${key} 必须为开关`);
    }
    if (typeof value.deepseekKey !== 'string') throw new Error('密钥字段格式无效');
    return value;
  }

  function init(pluginPath) {
    pluginDir = pluginPath;
    configPath = path.join(pluginPath, 'config.json');
    current = { ...DEFAULTS };
    loadError = '';
    try {
      if (fs.existsSync(configPath)) {
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('配置格式无效');
        current = validate({ ...DEFAULTS, ...saved });
      }
    } catch (e) {
      loadError = '配置无法读取或格式无效，正在使用默认值；原文件已保留。请修复原文件后重载插件，当前禁止覆盖保存。';
      console.warn(loadError);
      current = { ...DEFAULTS };
    }
    return current;
  }

  function get() {
    return current;
  }

  function save(partial, { recover = false } = {}) {
    let temporary;
    try {
      if (loadError && !recover) throw new Error(loadError);
      const next = validate({ ...current, ...partial });
      if (loadError && recover && fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, `${configPath}.invalid-${require('crypto').randomUUID()}.bak`, fs.constants.COPYFILE_EXCL);
      }
      temporary = `${configPath}.${require('crypto').randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, configPath);
      current = next;
      loadError = '';
    } catch (e) {
      const error = new Error(loadError || `保存配置失败（${e.code || e.message}），旧配置未改变`);
      errorHandler?.(error.message);
      throw error;
    } finally {
      if (temporary) {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* 不掩盖原始错误 */ }
      }
    }
    return current;
  }

  function baseUrl() {
    return `http://127.0.0.1:${current.port}`;
  }

  function pluginPath() {
    return pluginDir;
  }

  return { init, get, save, validate, baseUrl, pluginPath, DEFAULTS,
    getLoadError: () => loadError, onError: (handler) => { errorHandler = handler; } };
})();
