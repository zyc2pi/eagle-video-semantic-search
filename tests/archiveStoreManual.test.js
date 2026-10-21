const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-manual-test-'));
let failCommit = false;
const fakeFs = { ...fs, renameSync(source, target) {
  if (failCommit && path.basename(path.dirname(target)) === 'warehouse') throw new Error('commit failed');
  fs.renameSync(source, target);
} };
const context = { require: (name) => name === 'fs' ? fakeFs : require(name) };
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8')}\nthis.archive = ArchiveStore;`, context);
const archive = context.archive;
const copy = (value) => JSON.parse(JSON.stringify(value));
const library = 'D:/manual.library';
const open = (name, lib = library) => archive.open(path.join(root, name), lib);
const manifest = (name) => {
  const directory = path.join(root, name, 'warehouse');
  return path.join(directory, fs.readdirSync(directory).find((filename) => filename.endsWith('.json')));
};
const match = (start, id = 'video-a', videoPath = 'D:/video.mp4', similarity = 23) => ({
  eagleItemId: id, video_path: videoPath, start_frame: start - 1, end_frame: start + 11,
  original_start_frame: start, original_end_frame: start + 10, fps: 25, similarity,
});
const create = (store, matches, name = '目标主题') => store.add({ name, matches,
  recipe: { kind: 'text', query: 'target' }, view: { minDur: 0, sortBy: 'sim', grouped: false } });
const add = (store, entry, additions) => store.addMatches(entry.id, additions, entry.updatedAt, entry.revision || 0);
const input = (scene, score = 18.1, scoreMode = 'custom') => ({ match: scene, score, scoreMode });
const refresh = (store, entry, matches) => store.replace(archive.updatedEntry(entry, matches,
  entry.recipe, entry.view, '2026-10-03T12:00:00Z'), entry.updatedAt);

(async () => {
  try {
    const store = open('basic');
    const first = match(10); const second = match(30); const manual = match(50);
    let entry = create(store, [first, second]);
    const twin = create(store, [first], '来源主题');
    const initialTime = entry.updatedAt;
    const source = { ...manual, both_hit: true, matched_queries: ['source'] };
    let result = add(store, entry, [input(source, 23, 'top'), input(first, 21.2)]);
    entry = result.entry;
    assert.deepStrictEqual([result.added, result.rescored, result.restored], [1, 1, 0]);
    assert.strictEqual(entry.updatedAt, initialTime);
    assert.strictEqual(entry.revision, 1);
    assert.strictEqual(entry.summary.matches, 3);
    assert.strictEqual(entry.summary.videos, 1);
    assert.strictEqual(entry.matches.find((item) => archive.sceneKey(item) === archive.sceneKey(manual)).both_hit, undefined);
    assert.strictEqual(entry.matches[0].matched_queries, undefined);
    assert.strictEqual(entry.matches[0].manualScore.value, 21.2);
    assert.deepStrictEqual(copy(entry.newKeys), []);
    assert.strictEqual(store.list().entries.find((item) => item.id === twin.id).matches[0].similarity, 23);
    assert.strictEqual(open('basic', 'D:/other.library').list().entries.length, 0);
    assert.throws(() => open('basic', 'D:/other.library').addMatches(entry.id, [input(first)], entry.updatedAt, entry.revision), /已被删除/);

    const stale = copy(entry);
    entry = refresh(store, entry, [{ ...first, similarity: 90, video_path: 'E:/moved.mp4' }, second, match(90, 'new', 'D:/new.mp4', 100)]);
    assert.strictEqual(entry.matches.length, 4);
    assert.strictEqual(entry.matches[0].similarity, 21.2, '命中的人工片段保留固定分数');
    assert.strictEqual(entry.matches[0].video_path, 'E:/moved.mp4', '稳定 ID 随自动命中更新路径');
    assert.strictEqual(entry.matches.find((item) => item.manualScore?.mode === 'top').similarity, 23,
      '出现新的最高分后 top 分数保持不变');
    assert.deepStrictEqual(copy(entry.newKeys), [archive.sceneKey(match(90, 'new', 'D:/new.mp4', 100))]);
    assert.throws(() => add(store, stale, [input(second)]), /其他操作更新/);
    assert.throws(() => store.addMatches(entry.id, [input(second)], 'stale-time', entry.revision), /其他操作更新/);
    assert.throws(() => store.addMatches(entry.id, [input(second)], entry.updatedAt, entry.revision - 1), /其他操作更新/);
    entry = refresh(store, entry, []);
    assert.strictEqual(entry.matches.length, 2, '空搜索仍保留人工片段');
    assert.deepStrictEqual(copy(entry.newKeys), []);
    const key = archive.sceneKey(first);
    entry = store.removeMatches(entry.id, [key], entry.updatedAt, entry.revision).entry;
    assert.strictEqual(entry.removedMatches[0].match.manualScore.value, 21.2);
    entry = refresh(store, entry, [first, second]);
    assert(!entry.matches.some((item) => archive.sceneKey(item) === key), '人工片段也遵守移除排除');
    entry = store.restoreMatches(entry.id, [key], entry.updatedAt, entry.revision).entry;
    assert.strictEqual(entry.matches.find((item) => archive.sceneKey(item) === key).manualScore.value, 21.2);
    entry = refresh(store, entry, []);
    assert.strictEqual(entry.matches.length, 2, '恢复后仍是人工保留片段');
    entry = store.removeMatches(entry.id, [key], entry.updatedAt, entry.revision).entry;
    result = add(store, entry, [input(first, 0)]);
    entry = result.entry;
    assert.strictEqual(result.restored, 1);
    assert.strictEqual(entry.removedMatches.length, 0, '主动加入解除排除');
    assert.strictEqual(entry.matches.find((item) => archive.sceneKey(item) === key).similarity, 0);
    entry = refresh(store, entry, []);
    assert.strictEqual(entry.matches.length, 2);

    const filename = manifest('basic');
    const unchanged = fs.readFileSync(filename, 'utf8');
    const invalidInputs = [
      [input(second), input(match(70), NaN)], [input(first, Infinity)], [input(first, -0.1)],
      [input(first, '20')], [input(first, 20, 'dynamic')], [input({ ...first, original_start_frame: -1 })],
      [input({ ...first, original_end_frame: 9 })], [input({ ...first, video_path: '' })],
      [input({ ...first, eagleItemId: 123 })], [input({ ...first, manualScore: { value: 20, mode: 'custom', scoredAt: 'invalid' } })],
      [null], null,
    ];
    invalidInputs.forEach((batch) => assert.throws(() => add(store, entry, batch), /格式无效/));
    assert.strictEqual(fs.readFileSync(filename, 'utf8'), unchanged, '无效批次全部拒绝且不写盘');
    failCommit = true;
    assert.throws(() => add(store, entry, [input(second)]), /commit failed/);
    failCommit = false;
    assert.strictEqual(fs.readFileSync(filename, 'utf8'), unchanged);
    result = add(store, entry, []);
    assert.strictEqual(result.keys.length, 0);
    assert.strictEqual(fs.readFileSync(filename, 'utf8'), unchanged, '空添加不写盘');
    entry = add(store, entry, [input(second, 9999.9), input(second, 12.3)]).entry;
    assert.strictEqual(entry.matches.length, 3, '批次重复片段只保存一份');
    assert.strictEqual(entry.matches.find((item) => archive.sceneKey(item) === archive.sceneKey(second)).similarity, 12.3);

    const legacyStore = open('legacy');
    const legacy = { video_path: 'D:/OLD.MP4', start_frame: 10, end_frame: 20, similarity: 22 };
    let oldEntry = create(legacyStore, [legacy]);
    const promoted = { ...legacy, eagleItemId: 'resolved', video_path: 'd:\\old.mp4' };
    oldEntry = add(legacyStore, oldEntry, [input(promoted, 20)]).entry;
    assert.strictEqual(oldEntry.matches.length, 1);
    assert.strictEqual(oldEntry.matches[0].eagleItemId, 'resolved', '人工加入升级旧路径身份');
    oldEntry = add(legacyStore, oldEntry, [input(legacy, 19)]).entry;
    assert.strictEqual(oldEntry.matches[0].eagleItemId, 'resolved', '无 ID 来源不降级已有身份');
    oldEntry = refresh(legacyStore, oldEntry, [{ ...promoted, video_path: 'E:/moved.mp4' },
      { ...promoted, eagleItemId: 'different' }]);
    assert.strictEqual(oldEntry.matches.length, 2, '相同旧路径的不同已知 ID 保留两份');
    assert.strictEqual(oldEntry.matches[0].similarity, 19);
    oldEntry = add(legacyStore, oldEntry, [input({ ...promoted, eagleItemId: 'different' }, 18)]).entry;
    assert.strictEqual(oldEntry.matches.length, 2);
    oldEntry = refresh(legacyStore, oldEntry, []);
    assert.strictEqual(oldEntry.matches.length, 2);
    const legacyRemovedStore = open('legacy-removed');
    let legacyRemoved = create(legacyRemovedStore, [legacy]);
    legacyRemoved = legacyRemovedStore.removeMatches(legacyRemoved.id, [archive.sceneKey(legacy)],
      legacyRemoved.updatedAt, legacyRemoved.revision).entry;
    const legacyAdded = add(legacyRemovedStore, legacyRemoved, [input(promoted)]);
    assert.strictEqual(legacyAdded.restored, 1);
    assert.strictEqual(legacyAdded.entry.removedMatches.length, 0);
    const promotionStore = open('promotion-refresh');
    let promotionEntry = create(promotionStore, [legacy]);
    promotionEntry = add(promotionStore, promotionEntry, [input(legacy, 17)]).entry;
    promotionEntry = refresh(promotionStore, promotionEntry, [promoted]);
    assert.strictEqual(promotionEntry.matches.length, 1);
    assert.strictEqual(promotionEntry.matches[0].eagleItemId, 'resolved');
    assert.strictEqual(promotionEntry.matches[0].similarity, 17);
    assert.deepStrictEqual(copy(promotionEntry.newKeys), []);

    const reopened = open('basic').list().entries.find((item) => item.id === entry.id);
    assert(Object.getOwnPropertyDescriptor(reopened, 'matches').get);
    await store.hydrateEntry(reopened);
    assert.strictEqual(reopened.matches.filter((item) => item.manualScore).length, 3);
    const pack = store.exportBundle();
    const portable = open('portable');
    assert.strictEqual(portable.importBundle(pack), 2);
    let imported = portable.list().entries.find((item) => item.id === entry.id);
    await portable.hydrateEntry(imported);
    assert.deepStrictEqual(copy(imported.matches), copy(entry.matches));
    const backup = store.backups().find((item) => item.valid);
    assert(backup);
    store.remove(entry.id);
    const trashItem = store.list().trash.find((item) => item.entry.id === entry.id);
    const trashPack = open('trash-pack');
    trashPack.importBundle(store.exportBundle());
    const restoredTrash = trashPack.restore(trashItem.trashId);
    await trashPack.hydrateEntry(restoredTrash);
    assert.strictEqual(restoredTrash.matches.filter((item) => item.manualScore).length, 3);
    const restored = store.restore(trashItem.trashId);
    await store.hydrateEntry(restored);
    assert.strictEqual(restored.matches.filter((item) => item.manualScore).length, 3);
    store.restoreBackup(backup.name);
    assert(store.list().entries.find((item) => item.id === entry.id).matches.some((item) => item.manualScore));

    // Review state is target-local and shares atomic writes with quick scoring.
    const reviewStore = open('review');
    let review = create(reviewStore, [first, second]);
    const reviewTime = review.updatedAt;
    review = reviewStore.setReviewed(review.id, [archive.sceneKey(first)], true, review.updatedAt, review.revision).entry;
    const reviewedAt = review.matches[0].reviewedAt;
    assert(Number.isFinite(Date.parse(reviewedAt)));
    assert.strictEqual(review.matches[0].manualScore, undefined, '保留不把机器片段变成人工收录');
    assert.strictEqual(review.updatedAt, reviewTime);
    assert.strictEqual(review.matches[0].similarity, first.similarity);
    let refreshedReview = archive.updatedEntry(review, [first, second], review.recipe, review.view);
    assert.strictEqual(refreshedReview.matches[0].reviewedAt, reviewedAt, '自动命中重搜保留审阅标记');
    assert.strictEqual(archive.updatedEntry(review, [], review.recipe, review.view).matches.length, 0,
      '保留不让自动片段在失去命中后永久驻留');
    const moved = { ...first, video_path: 'E:/moved.mp4' };
    assert.strictEqual(archive.updatedEntry(review, [moved], review.recipe, review.view).matches[0].reviewedAt, reviewedAt);
    assert.strictEqual(archive.updatedEntry(review, [{ ...first, eagleItemId: 'other' }], review.recipe, review.view).matches[0].reviewedAt, undefined);
    const legacyReview = { ...review, matches: [{ ...review.matches[0], eagleItemId: undefined }] };
    assert.strictEqual(archive.updatedEntry(legacyReview, [first], review.recipe, review.view).matches[0].reviewedAt, reviewedAt);
    const targetLocal = create(reviewStore, [], '另一个主题');
    const targetAdded = add(reviewStore, targetLocal, [input(review.matches[0])]).entry;
    assert.strictEqual(targetAdded.matches[0].reviewedAt, undefined, '审阅状态不从来源传播');
    const rawReview = fs.readFileSync(manifest('review'), 'utf8');
    const kept = reviewStore.addMatches(review.id, [{ match: first, keepExisting: true }],
      review.updatedAt, review.revision);
    assert.strictEqual(kept.kept, 1);
    assert.strictEqual(kept.undoToken, null);
    assert.strictEqual(fs.readFileSync(manifest('review'), 'utf8'), rawReview, '保留原分的纯重复收录不写盘');
    assert.throws(() => reviewStore.addMatches(review.id, [{ match: manual, keepExisting: true }],
      review.updatedAt, review.revision), /有效分数/);
    failCommit = true;
    assert.throws(() => reviewStore.setReviewed(review.id, [archive.sceneKey(second)], true,
      review.updatedAt, review.revision), /commit failed/);
    assert.strictEqual(fs.readFileSync(manifest('review'), 'utf8'), rawReview);
    failCommit = false;
    const scored = reviewStore.addMatches(review.id, [input(second, 99)], review.updatedAt, review.revision, { markReviewed: true });
    assert(scored.entry.matches[1].reviewedAt);
    review = reviewStore.undoMatches(review.id, scored.undoToken, scored.entry.updatedAt, scored.entry.revision).entry;
    assert.strictEqual(review.matches[1].reviewedAt, undefined, '撤销审片评分同时恢复未审阅');
    assert.strictEqual(review.matches[1].similarity, second.similarity);
    const regraded = add(reviewStore, review, [input(first, 31)]);
    review = regraded.entry;
    assert.strictEqual(review.matches[0].reviewedAt, reviewedAt, '普通重评保留目标已有审阅状态');
    assert.throws(() => reviewStore.setReviewed(review.id, [archive.sceneKey(first)], false, review.updatedAt, 0), /其他操作更新/);
    const removedReview = reviewStore.removeMatches(review.id, [archive.sceneKey(first)], review.updatedAt, review.revision).entry;
    assert.strictEqual(removedReview.removedMatches[0].match.reviewedAt, reviewedAt);
    review = reviewStore.restoreMatches(review.id, [archive.sceneKey(first)], removedReview.updatedAt, removedReview.revision).entry;
    assert.strictEqual(review.matches.find((m) => archive.sceneKey(m) === archive.sceneKey(first)).reviewedAt, reviewedAt);
    const packedReview = open('review-pack');
    packedReview.importBundle(reviewStore.exportBundle());
    assert.strictEqual(packedReview.list().entries.find((e) => e.id === review.id).matches.find((m) => m.reviewedAt).reviewedAt, reviewedAt);
    review = reviewStore.setReviewed(review.id, [archive.sceneKey(first)], false, review.updatedAt, review.revision).entry;
    assert(!review.matches.some((m) => m.reviewedAt), '可显式重置审阅状态');
    assert.strictEqual(review.updatedAt, reviewTime);
    for (const value of [null, false, 123, 'invalid-date', {}]) {
      assert.throws(() => create(open(`bad-review-${typeof value}-${String(value)}`), [{ ...first, reviewedAt: value }]), /内容无效/);
    }

    // Corrupt manual markers are never accepted as ordinary automatic matches.
    for (const [index, marker] of [null, {}, { value: -1, mode: 'custom', scoredAt: '2026-10-03T00:00:00Z' },
      { value: 23, mode: 'bad', scoredAt: '2026-10-03T00:00:00Z' },
      { value: 24, mode: 'custom', scoredAt: '2026-10-03T00:00:00Z' },
      { value: 23, mode: 'custom', scoredAt: 'bad-date' }].entries()) {
      const corrupt = open(`corrupt-${index}`);
      assert.throws(() => create(corrupt, [{ ...first, manualScore: marker }]), /内容无效/);
      const valid = create(corrupt, [first]);
      const corruptFile = manifest(`corrupt-${index}`);
      const data = JSON.parse(fs.readFileSync(corruptFile, 'utf8'));
      data.entries[0].matches = [{ ...first, manualScore: marker }];
      delete data.entries[0].matchesRef;
      fs.writeFileSync(corruptFile, JSON.stringify(data));
      assert.strictEqual(corrupt.list().entries.length, 0);
      assert.strictEqual(corrupt.list().quarantine.length, 1);
      assert.throws(() => add(corrupt, valid, [input(first)]), /已被删除或资源无效/);
    }
    const corruptLazy = open('corrupt-lazy');
    const lazyEntry = create(corruptLazy, [first]);
    const lazyFile = manifest('corrupt-lazy');
    const lazyData = JSON.parse(fs.readFileSync(lazyFile, 'utf8'));
    const raw = JSON.stringify([{ ...first, manualScore: { value: 999, mode: 'custom', scoredAt: '2026-10-03T00:00:00Z' } }]);
    const ref = `${require('crypto').createHash('sha256').update(raw).digest('hex')}.json`;
    fs.writeFileSync(path.join(lazyFile.replace(/\.json$/, '-assets'), ref), raw);
    lazyData.entries[0].matchesRef = ref;
    fs.writeFileSync(lazyFile, JSON.stringify(lazyData));
    const broken = corruptLazy.list().entries[0];
    await assert.rejects(() => corruptLazy.hydrateEntry(broken), /内容无效/);
    const corruptUnchanged = fs.readFileSync(lazyFile, 'utf8');
    assert.throws(() => add(corruptLazy, lazyEntry, [input(first)]), /内容无效/);
    assert.throws(() => corruptLazy.exportBundle(), /内容无效/);
    assert.strictEqual(fs.readFileSync(lazyFile, 'utf8'), corruptUnchanged);
    const corruptRecipe = open('corrupt-recipe');
    const recipeEntry = create(corruptRecipe, [first]);
    const recipeFile = manifest('corrupt-recipe');
    const recipeData = JSON.parse(fs.readFileSync(recipeFile, 'utf8'));
    const invalidRecipe = '[]';
    const recipeRef = `${require('crypto').createHash('sha256').update(invalidRecipe).digest('hex')}.json`;
    fs.writeFileSync(path.join(recipeFile.replace(/\.json$/, '-assets'), recipeRef), invalidRecipe);
    recipeData.entries[0].recipeRef = recipeRef;
    fs.writeFileSync(recipeFile, JSON.stringify(recipeData));
    const recipeUnchanged = fs.readFileSync(recipeFile, 'utf8');
    assert.throws(() => add(corruptRecipe, recipeEntry, [input(second)]), /内容无效/);
    assert.strictEqual(fs.readFileSync(recipeFile, 'utf8'), recipeUnchanged,
      '返回前需要的资源先验证，不得先提交再因 hydrate 报失败');
    console.log('manual scene scoring, fixed scores, refresh union, exclusions, identities, atomic validation and resource recovery tests passed');
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('eagle-manual-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
