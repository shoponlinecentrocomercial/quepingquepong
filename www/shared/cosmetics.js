'use strict';
// Datos puros de cosméticos (UMD, como en billar). Sin dibujo: las funciones
// que convierten esto en píxeles viven en client.js (buildOpponentSprites /
// buildArmSprite / swatches de los pickers).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cosmetics = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const CHARACTERS = [
    { name: 'Nico', skin: '#e8b88a', hair: '#3a2a1a', hairStyle: 'flat', shirt: '#d43d3d', shorts: '#28304a' },
    { name: 'Mei', skin: '#f0c9a0', hair: '#1a1a22', hairStyle: 'bob', shirt: '#3d7ad4', shorts: '#222831' },
    { name: 'Rocco', skin: '#c98d5e', hair: '#101010', hairStyle: 'spiky', shirt: '#3db554', shorts: '#3a2a1a' },
    { name: 'Duna', skin: '#f5d5b5', hair: '#c96a20', hairStyle: 'pony', shirt: '#b04ad4', shorts: '#28304a' },
    { name: 'Bruno', skin: '#8a5a3a', hair: '#2a1a10', hairStyle: 'cap', shirt: '#e8a020', shorts: '#20262e' },
    { name: 'Zoe', skin: '#e8b88a', hair: '#d4d4e0', hairStyle: 'bob', shirt: '#20b8b0', shorts: '#3a2040' },
  ];

  const PADDLES = [
    { name: 'Clásica', rubber: '#c23030', back: '#1a1a1a', handle: '#b58a55' },
    { name: 'Noche', rubber: '#20242c', back: '#c23030', handle: '#4a4a55' },
    { name: 'Bosque', rubber: '#2c8a48', back: '#1a1a1a', handle: '#7a5a35' },
    { name: 'Ola', rubber: '#2f6fd0', back: '#c23030', handle: '#c9c9d4' },
    { name: 'Chicle', rubber: '#e060a8', back: '#20242c', handle: '#e8d5b5' },
  ];

  const TABLES = [
    { name: 'Club azul', top: '#2456a8', line: '#e8e8f0', side: '#183a74', floor: '#7a6248', wall: '#3a4254' },
    { name: 'Verde liga', top: '#1f7a44', line: '#e8e8f0', side: '#145230', floor: '#8a7050', wall: '#4a3f38' },
    { name: 'Gimnasio', top: '#28648a', line: '#f0e8d0', side: '#1a4560', floor: '#b09a68', wall: '#55606e' },
    { name: 'Neón', top: '#31285a', line: '#e858c0', side: '#201a3e', floor: '#2a2f3e', wall: '#141824' },
  ];

  return { CHARACTERS, PADDLES, TABLES };
});
