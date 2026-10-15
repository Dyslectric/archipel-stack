// Message bodies for watching a load run in a browser: vampire flex bars in the
// spirit of Dracula Flow. Each still ends with the benchmark marker, so delivery
// is measured exactly as in an ordinary run.
const lines = [
  "Walked in the castle, the bats did the wave 🦇",
  "My coffin got heated seats, yours got splinters",
  "I don't do mornings, I do mournings 🧛",
  "Sun came out so I went in. Simple math.",
  "Count so rich I count my money with my teeth 💰",
  "My cape got a cape. Drip on drip.",
  "Garlic bread at the function? I'm leaving, respectfully 🧄",
  "They said bite your tongue, I bit the whole guest list",
  "Moonlight is my ring light 🌕",
  "I'm 600 years old and still the youngest in the room",
  "Mirror can't see me and neither can my haters 🪞",
  "My blood type is 'premium'",
  "Turned into a bat just to skip the line 🦇🦇",
  "Castle so big it's got its own time zone 🏰",
  "I don't need a doorman, I need an invitation",
  "Sleep till dusk, flex till dawn",
  "My fangs got fangs 🦷",
  "Opened a bank account. Blood bank. Same energy.",
  "Wolves howling? That's my hype crew 🐺",
  "Nightlife? I invented night.",
  "My heartbeat retired in 1462, it's chilling now",
  "Stakes are high but I'm higher 📈",
  "Transylvania on my passport, VIP on my wristband",
  "Sunscreen SPF ten thousand, still staying inside",
  "I'm not ghosting you, I'm vampiring you",
  "Hit the club, the club hit back, I hit the club harder 🎶",
  "Drinking red, and it's not wine 🍷",
  "Crypt so clean you could eat off it. I don't, I drink.",
  "Cape flowing like my bars, fangs out, lights off",
  "They checked the guest list, I was the guest list",
  "My diet is strictly type O negative vibes",
  "Bats in my belfry, bands in my coffin",
  "I age like fine wine and look like fine wine",
  "Daylight savings? Never heard of her ☀️🚫",
  "Ten thousand in the room and they're all thirsty, same 🩸",
  "Counting sheep is beneath me. I count the Count.",
  "Pull up at midnight, leave before sunrise, legend",
  "My castle has Wi-Fi. Password: NoGarlic123",
  "Livin' forever is a flex and I'm flexin' forever",
  "Fangs polished, cape pressed, ego immortal 🧛‍♂️",
];
export const funny = (nick, due) => {
  const hash = [...`${nick}|${due}`].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 7);
  return `${lines[hash % lines.length]}  · `;
};
