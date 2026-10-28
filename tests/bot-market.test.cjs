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
    ask: { value: '1' }, bid: { value: '10' }, extract: { value: '3' },
    portChoice: { value: '0' }, markerChoice: { value: 'real' },
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
  });
  vm.runInContext(script, context);
  return {
    state: vm.runInContext('S', context),
    eval: code => vm.runInContext(code, context),
    elements,
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
    cursor: 0, sales: 0, history: [],
  };
  g.state.phase = 'marketResolve';
  g.eval('marketStep()');
  assert.equal(seller.cash, 42);
  assert.equal(buyer.cash, 8);
  assert.equal(buyer.boats[0].cargo, 2);
  assert.match(g.state.market.history[0], /at \$11 = \$22/);
});

test('opponents cannot see individual concession reserves', () => {
  const g = game();
  const screen = g.elements.app.innerHTML;
  assert.match(screen, /You \(Yellow\)<\/b><p>Cash \$20 · Island reserve 24/);
  assert.match(screen, /Blue<\/b><p>Cash \$20 · Island reserve Hidden/);
  assert.match(screen, /Green<\/b><p>Cash \$20 · Island reserve Hidden/);
  assert.doesNotMatch(g.elements.log.textContent, /Each island has 24/);
});

test('all hands commit without extracting until the simultaneous reveal', () => {
  const g = game();
  g.elements.extract.value = '2';
  g.eval('produce()');
  assert.equal(g.state.phase, 'extractReveal');
  assert.equal(g.state.commitments[0], 2);
  assert.equal(g.state.players[0].stock, 0);
  assert.equal(g.state.players[0].reserve, 24);
  assert.match(g.elements.app.innerHTML, /Reveal all hands/);
  g.eval('revealExtraction()');
  assert.equal(g.state.phase, 'peru');
  assert.equal(g.state.players[0].stock, 2);
  assert.equal(g.state.players[0].reserve, 22);
  assert.equal(g.state.commitments, null);
  assert.equal(g.state.exhausted, false);
});

test('combined extraction of two tonnes triggers exhaustion but leaves dock stock tradable', () => {
  const g = game();
  g.elements.extract.value = '0';
  g.state.players.slice(1).forEach((p, i) => { p.reserve = i < 2 ? 1 : 0; });
  g.state.players[0].stock = 4;
  g.eval('produce()');
  g.eval('revealExtraction()');
  assert.equal(g.state.exhausted, true);
  assert.equal(g.state.docksClosed, false);
  assert.equal(g.state.phase, 'peru');
  assert.equal(g.state.players[0].stock, 4);
  assert.match(g.elements.log.textContent, /Total 2 tonnes/);
});

test('the exhausted game continues Peru markets while at least one sale occurs', () => {
  const g = game();
  g.state.exhausted = true;
  g.state.players[0].stock = 2;
  g.state.players[1].cash = 30;
  g.state.market = {
    asks: [{ i: 0, price: 1, left: 2 }],
    bids: [{ i: 1, k: 0, price: 5 }],
    cursor: 0, sales: 0, history: [],
  };
  g.state.phase = 'marketResolve';
  g.eval('marketStep()');
  assert.equal(g.state.market.sales, 1);
  assert.equal(g.state.docksClosed, false);
  g.eval('finishRound()');
  assert.equal(g.state.phase, 'peru');
});

test('a Peru market without sales closes the docks and begins the final voyage', () => {
  const g = game();
  g.state.exhausted = true;
  g.state.players[0].stock = 3;
  g.state.market = { asks: [{ i: 0, price: 3, left: 3 }], bids: [], cursor: 0, sales: 0, history: [] };
  g.state.phase = 'marketResolve';
  g.eval('marketStep()');
  assert.equal(g.state.docksClosed, true);
  assert.equal(g.state.finalMoves, 2);
  assert.equal(g.state.phase, 'sail');
  assert.equal(g.state.players[0].stock, 3); // Unsold guano remains, but can no longer be purchased.
});

test('two final movements carry loaded Peru boats to Europe after the docks close', () => {
  const g = game();
  g.state.exhausted = true;
  g.state.docksClosed = true;
  g.state.finalMoves = 2;
  g.state.phase = 'sail';
  g.state.players[0].boats[0].cargo = 1;
  g.eval('sail()');
  assert.equal(g.state.players[0].boats[0].zone, 1);
  assert.equal(g.state.finalMoves, 1);
  assert.equal(g.state.phase, 'finalSail');
  g.eval('sail()');
  assert.equal(g.state.players[0].boats[0].zone, 2);
  assert.equal(g.state.phase, 'europe');
  g.eval('euroHuman()');
  g.eval('euroPass()');
  assert.equal(g.state.phase, 'end');
  assert.equal(g.state.finalMoves, 0);
  assert.equal(g.state.players[0].boats[0].cargo, 0);
  assert.equal(g.state.players[0].cash, 29); // Liverpool rose to $10 in the first voyage, then -1 tonne.
});
