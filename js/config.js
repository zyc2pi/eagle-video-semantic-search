/* 配置持久化：<插件目录>/config.json */
const Config = (() => {
  const fs = require('fs');
  const path = require('path');

  const DEFAULTS = {
    projectRoot: 'D:\\Auto-scenes-extraction-1.3.0\\Auto-scenes-extraction-1.3.0',
    port: 5006,
    modelName: 'qihoo360-fg-clip2-base',
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
    indexBatchSize: 128,         // GPU 批大小
    indexSceneThreshold: 0.85,   // 场景切分余弦阈值，越高切得越碎
    indexLocalmaxOrder: 2,       // 边界检测局部极小值阶数
    indexFp16: true,             // FP16 推理（仅 NVIDIA GPU 生效）
    miniKeepLoaded: false,       // MiniCPM 常驻显存（生成提示词提速，需 8GB+ 显存）
    // 搜索范围：all=整个库；selected=跟随 Eagle 当前选中文件夹；custom=指定文件夹列表
    scopeMode: 'all',
    scopeFolderIds: [],          // custom 模式勾选的文件夹 id（搜索时递归展开子文件夹）
    scopeLibrary: '',            // 勾选时所在的库路径，换库后自动重置为 all
    // 静默自动索引：插件随 Eagle 后台运行时，定时检查新素材并自动增量索引
    autoIndex: false,
    deepseekKey: '',    // DeepSeek API key，注入服务进程环境供 AI 查询增强使用
    aiEnhance: false,   // AI 查询增强总开关：双语改写（需配置 DeepSeek key）
    aiExpand: false,    // AI 语义扩展：额外生成同义/场景变体查询（最多 8 条，多路合并）
    aiMode: 'balanced', // AI 查询增强档位 fast/balanced/quality（变体数量与质量权衡）
    dedup: false,       // 跨视频去重
    dedupThreshold: 0.95, // 去重相似度阈值：越低合并越激进
    exportMode: 'copy', // 导出片段模式：copy=流拷贝快无损；precision=逐帧精确重编码
    miniRerank: false,  // MiniCPM 二阶段精搜（慢，占显存大）
    history: [],        // 最近搜索词
  };

  let configPath = null;
  let pluginDir = null;
  let current = { ...DEFAULTS };

  function init(pluginPath) {
    pluginDir = pluginPath;
    configPath = path.join(pluginPath, 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        current = { ...DEFAULTS, ...saved };
      }
    } catch (e) {
      console.warn('读取配置失败，使用默认值', e);
      current = { ...DEFAULTS };
    }
    return current;
  }

  function get() {
    return current;
  }

  function save(partial) {
    current = { ...current, ...partial };
    try {
      fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf-8');
    } catch (e) {
      console.error('保存配置失败', e);
    }
    return current;
  }

  function baseUrl() {
    return `http://127.0.0.1:${current.port}`;
  }

  function pluginPath() {
    return pluginDir;
  }

  return { init, get, save, baseUrl, pluginPath, DEFAULTS };
})();
