const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'game script exists');

function game() {
  const elements = {
    count: { value: '5' }, status: {}, app: {}, log: {},
    ask: { value: '1' }, bid: { value: '10' },
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
  });
  vm.runInContext(script, context);
  return {
    state: vm.runInContext('S', context),
    eval: code => vm.runInContext(code, context),
  };
}

function glut(g) {
  g.state.players.forEach((p, i) => {
    p.cash = 80;
    p.stock = [3, 6, 6, 5, 8][i];
    p.boats.forEach(b => { b.zone = 2; b.cargo = 0; });
  });
  g.state.players[3].boats[1] = { zone: 0, cargo: 2 };
  g.state.players[4].boats[1] = { zone: 0, cargo: 0 };
  g.state.markets[0].price = 21;
}

test('bots see the 28-tonne dock surplus and discount offers', () => {
  const g = game();
  glut(g);
  const c = g.eval('marketConditions()');
  assert.equal(c.supply, 28);
  assert.equal(c.sellers, 5);
  assert.equal(c.capacity, 6);
  assert.equal(c.buyers, 2);
  assert.ok(c.pressure > 1);
  assert.ok(g.eval('botAsk(S.players[4], marketConditions())') <= 4);
  assert.ok(g.eval('botAsk(S.players[2], marketConditions())') <= 5);
  assert.ok(g.eval('botBid(S.players[3], marketConditions())') <= 7);
});

test('scarce stock raises seller minimums and buyer offers', () => {
  const g = game();
  glut(g);
  const glutAsk = g.eval('botAsk(S.players[4], marketConditions())');
  const glutBid = g.eval('botBid(S.players[3], marketConditions())');
  g.state.players.forEach((p, i) => {
    p.stock = i === 4 ? 8 : 0;
    p.boats.forEach(b => { b.zone = 0; b.cargo = 0; });
  });
  g.state.players[3].boats[0].zone = 2;
  g.state.players[3].boats[1].cargo = 2;
  assert.ok(g.eval('botAsk(S.players[4], marketConditions())') > glutAsk);
  assert.ok(g.eval('botBid(S.players[3], marketConditions())') > glutBid);
});

test('initial cash limits seller asks to affordable buyer offers', () => {
  const g = game();
  g.state.players.forEach(p => { p.cash = 20; p.stock = 3; });
  const c = g.eval('marketConditions()');
  assert.equal(c.typicalBudget, 5);
  assert.ok(g.eval('botAsk(S.players[1], marketConditions())') <= 5);
  assert.equal(g.eval('botBid(S.players[1], marketConditions())'), 5);
});

test('low European prices cap seller asks and buyer bids below the listed port price', () => {
  const g = game();
  glut(g);
  g.state.markets.forEach(m => { m.price = 7; });
  const c = g.eval('marketConditions()');
  assert.equal(c.bestEuropean, 7);
  assert.equal(c.expectedDelivery, 4);
  assert.equal(c.maxPurchasePrice, 2); // $7 listed - 4 tonnes unloaded - $1 target margin.
  const asks = [1, 2, 3, 4].map(i => g.eval(`botAsk(S.players[${i}], marketConditions())`));
  const offer = g.eval('botBid(S.players[3], marketConditions())');
  assert.ok(asks.every(p => p <= 2));
  assert.ok(offer <= 2);
  assert.ok(asks.some(p => p <= offer), 'bots should still be able to trade during a glut');
});

test('a one-tonne shipment allows a higher European resale-based offer', () => {
  const g = game();
  g.state.players.forEach(p => { p.stock = 0; p.cash = 80; });
  g.state.players[4].stock = 1;
  g.state.markets.forEach(m => { m.price = 7; });
  const c = g.eval('marketConditions()');
  assert.equal(c.expectedDelivery, 1);
  assert.equal(c.maxPurchasePrice, 5);
  assert.equal(g.eval('botAsk(S.players[4], marketConditions())'), 5);
  assert.equal(g.eval('botBid(S.players[3], marketConditions())'), 5);
});

test('sale still pays the buyer offer, never the seller minimum or midpoint', () => {
  const g = game();
  const seller = g.state.players[0], buyer = g.state.players[1];
  seller.stock = 2;
  buyer.cash = 30;
  g.state.market = {
    asks: [{ i: 0, price: 1, left: 2 }],
    bids: [{ i: 1, k: 0, price: 11 }],
    cursor: 0, history: [],
  };
  g.state.phase = 'marketResolve';
  g.eval('marketStep()');
  assert.equal(seller.cash, 42);
  assert.equal(buyer.cash, 8);
  assert.equal(buyer.boats[0].cargo, 2);
  assert.match(g.state.market.history[0], /at \$11 = \$22/);
});
