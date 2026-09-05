(function () {
  'use strict';
  var people = 4, cents = 15250;
  var fewer = document.getElementById('fewer'), more = document.getElementById('more');
  function paint() {
    var share = Math.ceil(cents / people);
    document.getElementById('party').textContent = people + (people === 1 ? ' guest' : ' guests');
    document.getElementById('share').textContent = '$' + (share / 100).toFixed(2);
    document.getElementById('remainder').textContent = people === 1 ? 'The whole table is on you' : '$' + ((cents - share) / 100).toFixed(2) + ' left for the other guests';
    fewer.disabled = people === 1;
    more.disabled = people === 12;
  }
  if (!fewer || !more) return;
  fewer.addEventListener('click', function () { people = Math.max(1, people - 1); paint(); });
  more.addEventListener('click', function () { people = Math.min(12, people + 1); paint(); });
  paint();
})();
