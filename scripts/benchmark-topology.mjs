export function deliveryCoverage(options, instances) {
  const count = options.instances ?? instances.length;
  const scheduled = instances.reduce((n, row) => n + row.web.writes.scheduled + row.native.writes.scheduled, 0);
  if (instances.some(row => !row.web.writes.scheduledByRoom || !row.native.writes.scheduledByRoom)) {
    return { nativeExpectedFromOfferedPosts: scheduled * options.native * count / options.rooms,
      webExpectedFromOfferedPosts: scheduled * (options.members - options.native) * count / options.rooms };
  }
  const native = Array(options.rooms).fill(0), web = Array(options.rooms).fill(0);
  for (let i = 0; i < options.members; i++) {
    (i < options.members - options.native ? web : native)[i % options.rooms] += count;
  }
  let nativeExpectedFromOfferedPosts = 0, webExpectedFromOfferedPosts = 0;
  for (const instance of instances) for (const protocol of ['web', 'native']) {
    for (const [room, posts] of Object.entries(instance[protocol].writes.scheduledByRoom)) {
      nativeExpectedFromOfferedPosts += posts * native[Number(room)];
      webExpectedFromOfferedPosts += posts * web[Number(room)];
    }
  }
  return { nativeExpectedFromOfferedPosts, webExpectedFromOfferedPosts };
}
