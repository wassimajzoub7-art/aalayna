/* Scenario assumptions, not forecasts or observed restaurant performance. */
(function(root){
 'use strict';
 function clamp(value,min,max,fallback){var n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
 function guests(v){
  var week=v.paid*v.adoption/100*v.capture/100, submissions=week*4.33*3;
  var unique=submissions*v.unique/100, eligible=unique*v.permission/100, back=eligible*v.returnrate/100;
  return {week:week,month:week*4.33,submissions:submissions,unique:unique,quarter:eligible,back:back,value:back*v.check};
 }
 var api={clamp:clamp,guests:guests};if(typeof module==='object'&&module.exports)module.exports=api;else root.AalaynaNumbers=api;
})(typeof window==='undefined'?this:window);
