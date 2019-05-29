var config = require('./sample-config.json')
var binance = require('node-binance-api')().options({
    APIKEY: config.API_KEY,
    APISECRET: config.SECRET_KEY,
    useServerTime: true
});
const pair = config.PAIR;
const coin1 = pair[0];
const coin2 = pair[1];
const market = pair[0] + pair[1];

var tickSize = 0;
var minQty = 0;
var stepSize = 0;
var minNotional = 0;

var filters = [];
function roundPrices(v) {
    return Number(v).toFixed(tickSize);
}
function roundAmounts(v) {
    return (Number(v) - minQty).toFixed(stepSize);
}
function compare(a, b) {
    var diff = Number(a)-Number(b);
    if (diff > tickSize) return 1;
    if (diff < -tickSize) return -1;
    return 0;
}

function numdigits(v) {
    var x = Number(v);
    if (x == 0) return 0;
    var count = 0;
    while (x < 1) {
        x = 10*x;
        count = count +1;
    }
    return count;
}

binance.exchangeInfo((error, excInfo) => {
    if (error) return console.error(error);
    excInfo.symbols.forEach((item) => {
        if (item.symbol == market) {
            filters = item.filters;
            console.log("Filters set.");
            filters.forEach((filter) => {
                if (filter.filterType == "PRICE_FILTER") {
                    tickSize = numdigits(filter.tickSize);
                } else if (filter.filterType == "LOT_SIZE") {
                    minQty = Number(filter.minQty);
                    stepSize = numdigits(filter.stepSize);
                } else if (filter.filterType == "MIN_NOTIONAL") {
                    minNotional = Number(filter.minNotional);
                }
            });
        }
    });
    setInterval(function () {
        var dateAtual = new Date();
        binance.balance((error, balances) => {
            if (error) return console.error(error);
            binance.prevDay(market, (error, prevDay, symbol) => {
                if (error)
                    return console.error(error);
                var balance1 = 0;
                if (balances[coin1]) {
                    balance1 = parseFloat(balances[coin1].onOrder) + parseFloat(balances[coin1].available);
                }
                var balance2 = 0;
                if (balances[coin2]) {
                    balance2 = parseFloat(balances[coin2].onOrder) + parseFloat(balances[coin2].available);
                }

                const total = (balance1 * Number(prevDay.lastPrice)) + balance2;
                console.clear();
                console.log("==========================================");
                if (balances[coin1]) {
                    console.log("SALDO " + coin1 + "...:", balance1, "USD", "(", balances[coin1].available, "+", balances[coin1].onOrder, ")" );
                }
                if (balances[coin2]) {
                    console.log("SALDO " + coin2 + "...:", balance2, "USD", "(", balances[coin2].available, "+", balances[coin2].onOrder, ")" );
                }
                console.log("SALDO TOTAL..:", total, "USD")
                console.log("SALDO INICIAL:", config.INITIAL_INVESTMENT, "USD")
                console.log("LUCRO........:", total - config.INITIAL_INVESTMENT, "USD")
                dateAtual = new Date();
                console.log("@", dateAtual.getHours() + ':' + dateAtual.getMinutes() + ':' + dateAtual.getSeconds());
                console.log("==========================================");
                if (config.STRATEGY == "SIMPLE" || config.STRATEGY == "SUPERSIMPLE") {
                    simpleStrategy(balances, prevDay);
                } else if (config.STRATEGY == "STOP") {
                    stopStrategy(balances, prevDay);
                }
            });
        });
    }, 10000)
});

function simpleStrategy(balances, prevDay) {
    var buy = 0;
    var sell = 0;
    if (config.STRATEGY == "SIMPLE") {
        var weightedAvgPrice = Number(prevDay.weightedAvgPrice);
        var spread = config.SPREAD;
        buy = weightedAvgPrice * (1 - spread);
        sell = weightedAvgPrice * (1 + spread);
        createSimpleOrders(buy, sell, prevDay, balances);
    } else {
        binance.prevDay(market, (error, prevDay, symbol) => {
            if (error)
                return console.error(error);
            if (prevDay.priceChangePercent > 0) {
                buy = config.BUY_PRICES[0];
                sell = config.SELL_PRICES[0];
            } else {
                buy = config.BUY_PRICES[1];
                sell = config.SELL_PRICES[1];
            }
            createSimpleOrders(buy, sell, prevDay, balances);
        });
    }
}

function createSimpleOrders(buy, sell, prevDay, balances) {

    buy = roundPrices(buy);
    sell = roundPrices(sell);
    console.log("Cotação " + market, prevDay.lastPrice);
    console.log("Preço Medio " + market, prevDay.weightedAvgPrice);
    console.log("Definidos: compra " + buy + " e venda " + sell);
    if (balances[coin2] && Number(roundAmounts(balances[coin2].available)) > minNotional) {
        console.log("Compra: " + buy);
        binance.buy(market, roundAmounts(balances[coin2].available / buy), buy);
    }
    if (balances[coin1] && Number(roundAmounts(Number(balances[coin1].available) * sell)) > minNotional) {
        console.log("Venda: " + sell);
        binance.sell(market, roundAmounts(balances[coin1].available), sell);
    }
    binance.openOrders(false, (error, openOrders) => {
        if (error)
            return console.error(error);
        if (openOrders) {
            console.log("============== Open Orders ===============");
            openOrders.forEach(function (item) {
                console.log("[", item.orderId, ",", item.side, ",", item.symbol, ", amount:", item.origQty, ", price:", item.price, "]");
                if ( (item.side == "BUY" && compare(item.price, buy) > 0) || (item.side == "SELL" && compare(item.price, sell) < 0) ) {
                    binance.cancel(item.symbol, item.orderId);
                    console.log("Price out of range, canceling order...");
                } else if ( item.symbol != market ) {
                    binance.cancel(item.symbol, item.orderId);
                    console.log("Wrong market, canceling order...");
                }
            });
            console.log("============== Open Orders ===============");
        }
    });
}

function stopStrategy(balances) {
    binance.prevDay(market, (error, prevDay, symbol) => {
        if (error)
            return console.error(error);
        var price = Number(prevDay.lastPrice);
        var spread = config.SPREAD;
        var stopBuy = price * (1 + spread);
        var buy = price * (1 + 2*spread);
        var stopSell = price * (1 - spread);
        var sell = price * (1 - 2*spread);

        // adjusts to 4 decimals
        buy = roundPrices(buy);
        sell = roundPrices(sell);
        stopBuy = roundPrices(stopBuy);
        stopSell = roundPrices(stopSell);

        console.log("Cotação", market, prevDay.lastPrice);
        console.log("Stops: compra " + stopBuy + " e venda " + stopSell);
        console.log("Preços: compra " + buy + " e venda " + sell);
        var cancelPromises = [];
        
        var openOrdersPromise = new Promise((resolve, reject) => {
            binance.openOrders(false, (error, openOrders) => {
                if (error) {
                    reject(error);
                    return console.error(error);
                }
                var toCancel = false;
                var reason = "";
                if (openOrders) {
                    console.log("============== Open Orders ===============");
                    openOrders.forEach(function (item) {
                        console.log("[", item.orderId, ",", item.side, ",", item.symbol, 
                                ", amount:", roundAmounts(item.origQty), 
                                ", price:", roundPrices(item.price), 
                                ", stop:", roundPrices(item.stopPrice), "]");
                        // cancel all orders that are not stop
                        if (item.type != 'STOP_LOSS' && item.type != 'STOP_LOSS_LIMIT') {
                            reason = "Not STOP_LOSS or STOP_LOSS_LIMIT";
                            toCancel = true;
                        }
                        // cancel buy orders below stop limit
                        if (!toCancel && item.symbol != market) {
                            reason = "Wrong market";
                            toCancel = true;
                        }
                        // cancel buy orders below stop limit
                        if (!toCancel && item.side == "BUY" && compare(item.stopPrice, stopBuy) > 0) {
                            reason = "stopPrice > stopBuy";
                            toCancel = true;
                        }
                        // cancel sell orders above stop limit
                        if (!toCancel && item.side == "SELL" && compare(item.stopPrice, stopSell) < 0) {
                            reason = "stopPrice < stopSell";
                            toCancel = true;
                        }
                        if (toCancel) {
                            var symbol = item.symbol;
                            var orderId = item.orderId;
                            console.log("Canceling order", orderId, ":", reason);
                            var promise = new Promise((reresolve, rereject) => {
                                binance.cancel(symbol, orderId, (error, openOrders) => {
                                    if (error) {
                                        rereject(error);
                                        return console.log(error)
                                    }
                                    reresolve("Success!");
                                    console.log("canceled order: ", orderId)
                                });
                            });
                            cancelPromises.push(promise);
                        }
                    });
                    console.log("============== Open Orders ===============");
                }
                resolve("Success!")
            });
        });
        openOrdersPromise.then(() => {
            if (cancelPromises) {
                Promise.all(cancelPromises).then(() => {
                    placeStopOrders(balances, stopBuy, buy, stopSell, sell);
                });
            } else {
                placeStopOrders(balances, stopBuy, buy, stopSell, sell);
            }
        });
    });
}

function placeStopOrders(balances, stopBuy, buy, stopSell, sell) {
    // get balances again
    var p = new Promise((resolve, reject) => {
        binance.balance((error, balances) => {
            if (error) {
                reject(error);
                return console.log(error)
            }
            if (balances[coin2] && Number(roundAmounts(balances[coin2].available)) > minNotional) {
                console.log("Compra: " + stopBuy);
                binance.order("BUY", market, roundAmounts(balances[coin2].available / buy), buy, {
                    type: "STOP_LOSS_LIMIT",
                    stopPrice: stopBuy
                }, (error, result) => {
                    if (error) return console.log(error);
                    console.log(result);
                });
            }
            if (balances[coin1] && Number(roundAmounts(Number(balances[coin1].available) * sell)) > minNotional) {
                console.log("Venda: " + stopSell);
                binance.order("SELL", market, roundAmounts(balances[coin1].available), sell, {
                    type: "STOP_LOSS_LIMIT",
                    stopPrice: stopSell
                }, (error, result) => {
                    if (error) return console.log(error);
                    console.log(result);
                });
            }
            resolve("Done.");
        });
    });
    p.then(() => {
        console.log("Done.");
    });
}
