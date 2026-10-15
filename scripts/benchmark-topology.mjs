export function roomHost(options, room) {
  return options.roomHost ?? room % options.instances;
}

export function memberCounts(options) {
  const counts = options.membersPerInstance ?? Array(options.instances).fill(options.members);
  if (counts.length !== options.instances || counts.some(n => !Number.isSafeInteger(n) || n < options.rooms))
    throw new Error('members-per-instance must contain one integer per instance, each at least the room count.');
  return counts;
}

export function deliveryCoverage(options, instances) {
  const count = options.instances ?? instances.length;
  const populations = options.webMembersPerInstance ?? options.membersPerInstance ?? Array(count).fill(options.members);
  const totalMembers = populations.reduce((a, b) => a + b, 0);
  const scheduled = instances.reduce((n, row) => n + row.web.writes.scheduled + row.native.writes.scheduled, 0);
  if (instances.some(row => !row.web.writes.scheduledByRoom || !row.native.writes.scheduledByRoom)) {
    return { nativeExpectedFromOfferedPosts: scheduled * options.native * count / options.rooms,
      webExpectedFromOfferedPosts: scheduled * (totalMembers - options.native * count) / options.rooms };
  }
  const native = Array(options.rooms).fill(0), web = Array(options.rooms).fill(0);
  for (const members of populations) for (let i = 0; i < members; i++) {
    (i < members - options.native ? web : native)[i % options.rooms]++;
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
