// Lays an estate's plots out as an illustrative site plan: two rows facing an
// access road. This is a schematic, not a survey drawing.
const W = 128; const H = 98; const GAP = 10; const PAD = 26; const ROAD = 56;

function layout(plots) {
  const perRow = Math.max(1, Math.ceil(plots.length / 2));
  const width = PAD * 2 + perRow * W + (perRow - 1) * GAP;
  const height = PAD * 2 + H * 2 + ROAD + 20;
  const topY = PAD + 12;
  const roadY = topY + H;
  const bottomY = roadY + ROAD;
  const items = plots.map((plot, i) => {
    const row = i < perRow ? 0 : 1;
    const col = row === 0 ? i : i - perRow;
    return { plot, x: PAD + col * (W + GAP), y: row === 0 ? topY : bottomY, w: W, h: H };
  });
  return { width, height, items, road: { x: 0, y: roadY, w: width, h: ROAD }, roadLabelY: roadY + ROAD / 2 + 4 };
}

module.exports = { layout };
