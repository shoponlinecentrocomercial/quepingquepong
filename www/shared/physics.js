'use strict';
// Motor de ping pong compartido cliente/servidor (UMD, como en billar).
// Determinista: cero Math.random aquí dentro — el input son solo posiciones
// de pala (setPaddle) y la acción de saque (serve). Toda la aleatoriedad
// (errores de la IA, etc.) vive fuera del motor.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Physics = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Unidades ~cm. x = ancho (0 en el centro), y = profundidad (0 = red),
  // z = altura (0 = superficie de la mesa). Asiento 0 juega en y<0.
  const W = 152, L = 274;
  const HALF_W = W / 2, HALF_L = L / 2;
  const NET_H = 15;        // altura de la red
  const NET_X = 84;        // la red sobresale lateralmente hasta |x| < NET_X
  const G = 980;           // gravedad cm/s^2
  const SUB = 1 / 240;     // substep fijo de integración (como billar)
  const TABLE_REST = 0.82; // restitución del bote en la mesa
  const BOUNCE_FRICTION = 0.94;
  const FLOOR_Z = -55;     // el suelo fuera de la mesa está por debajo
  const PADDLE_Y = 150;    // plano base de las palas (|y|)
  const PADDLE_X_MAX = 120;
  const PADDLE_Y_MIN = 142, PADDLE_Y_MAX = 176; // banda de profundidad de la pala
  const REACH_X = 26;      // alcance lateral de golpeo
  const HIT_Z_MIN = -8, HIT_Z_MAX = 62; // ventana vertical de golpeo (generosa, arcade)
  const BALL_VIS_R = 2.2;  // radio "físico" solo para el render

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function createState(firstServer) {
    const s = {
      ball: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, live: false },
      paddles: [
        { x: 0, y: -PADDLE_Y, vx: 0, vy: 0, tx: 0, ty: -PADDLE_Y },
        { x: 0, y: PADDLE_Y, vx: 0, vy: 0, tx: 0, ty: PADDLE_Y },
      ],
      phase: 'serve',          // serve | rally | between | over
      server: firstServer,
      firstServer,
      scores: [0, 0],
      lastTouch: null,         // asiento que tocó la bola por última vez
      serving: false,          // entre serve() y completar el saque
      bouncedOwn: false,       // el saque ya botó en campo propio
      recvBounces: 0,          // botes en campo receptor desde el último toque
      netTouched: false,       // la bola tocó la red desde el último toque
      winner: null,
    };
    glueBall(s);
    return s;
  }

  // Entre puntos la bola "viaja" pegada a la pala del sacador.
  function glueBall(s) {
    const p = s.paddles[s.server];
    const dir = s.server === 0 ? 1 : -1;
    const b = s.ball;
    b.x = p.x; b.y = p.y + dir * 8; b.z = 25;
    b.vx = 0; b.vy = 0; b.vz = 0; b.live = false;
  }

  // El input son POSICIONES objetivo; step() deriva las velocidades de pala a
  // partir de ellas — así cliente y servidor producen la misma física con los
  // mismos inputs, sin depender de relojes.
  function setPaddle(state, seat, x, y) {
    const p = state.paddles[seat];
    p.tx = clamp(x, -PADDLE_X_MAX, PADDLE_X_MAX);
    const sign = seat === 0 ? -1 : 1;
    const ay = clamp(Math.abs(y), PADDLE_Y_MIN, PADDLE_Y_MAX);
    p.ty = sign * ay;
  }

  // Saque arcade de un toque: trayectoria canónica que bota en campo propio y
  // cruza la red — el "doble bote reglamentario" emerge de la trayectoria.
  // La x de la pala (y su velocidad) desplazan lateralmente el saque.
  function serve(state, seat, events) {
    if (state.phase !== 'serve' || state.server !== seat) return false;
    const p = state.paddles[seat];
    const b = state.ball;
    const dir = seat === 0 ? 1 : -1;
    // T1/ownY/z afinados para que el segundo bote (campo receptor) caiga
    // profundo y la bola llegue al plano de la pala rival antes del tercero.
    const T1 = 0.32; // tiempo hasta el bote propio
    b.x = p.x; b.y = p.y + dir * 8; b.z = 25;
    const bx = clamp(p.x + p.vx * 0.08, -60, 60);
    const ownY = seat === 0 ? -42 : 42; // bote propio, cerca de la red
    b.vx = (bx - b.x) / T1;
    b.vy = (ownY - b.y) / T1;
    b.vz = (0.5 * G * T1 * T1 - b.z) / T1;
    b.live = true;
    state.phase = 'rally';
    state.lastTouch = seat;
    state.serving = true;
    state.bouncedOwn = false;
    state.recvBounces = 0;
    state.netTouched = false;
    if (events) events.push({ type: 'serve', seat, x: b.x, y: b.y });
    return true;
  }

  // Sacador reglamentario: alterna cada 2 puntos; a partir de 10-10, cada
  // punto. Compartido servidor/cliente-offline: por eso vive en shared/.
  function serverFor(scores, firstServer) {
    const total = scores[0] + scores[1];
    if (scores[0] >= 10 && scores[1] >= 10) return (firstServer + total) % 2;
    return (firstServer + Math.floor(total / 2)) % 2;
  }

  function applyPoint(state, winner) {
    state.scores[winner]++;
    const [a, b] = state.scores;
    if ((a >= 11 || b >= 11) && Math.abs(a - b) >= 2) {
      state.phase = 'over';
      state.winner = a > b ? 0 : 1;
    } else {
      state.server = serverFor(state.scores, state.firstServer);
      state.phase = 'serve';
    }
    glueBall(state);
  }

  function pointScored(state, winner, reason, events) {
    state.ball.live = false;
    state.phase = 'between';
    events.push({ type: 'point', winner, reason });
  }

  // Golpe automático "por objetivo": el offset de contacto en la pala y la
  // velocidad de la pala en ese instante deciden el punto de aterrizaje; la
  // potencia aplana el arco. Los fallos a red (golpe bajo + smash) y los
  // tiros fuera (offset extremo, mucha profundidad) EMERGEN de este modelo,
  // no se guionizan.
  function hitBall(state, seat, events) {
    const b = state.ball, p = state.paddles[seat];
    const dir = seat === 0 ? 1 : -1; // hacia el campo rival
    const offset = clamp((b.x - p.x) / REACH_X, -1, 1);
    const swing = p.vx;
    const power = Math.min(1, 0.3 + Math.abs(swing) / 700 + Math.abs(b.vy) / 1600);
    const tx = clamp(offset * 62 + swing * 0.055, -95, 95);
    const ty = dir * (34 + power * 100);
    const T = 0.85 - power * 0.42;
    b.vx = (tx - b.x) / T;
    b.vy = (ty - b.y) / T;
    let vz = (0.5 * G * T * T - Math.max(b.z, 2)) / T;
    // Smash = arco más plano de lo que pide la balística; desde una bola
    // baja eso significa red — es el riesgo del golpe potente.
    if (power > 0.7) vz *= 1.15 - power * 0.45;
    b.vz = vz;
    state.lastTouch = seat;
    state.serving = false;
    state.bouncedOwn = false;
    state.recvBounces = 0;
    state.netTouched = false;
    events.push({
      type: 'paddle', seat, x: b.x, y: b.y, z: b.z,
      speed: Math.hypot(b.vx, b.vy), power,
    });
  }

  function substep(state, h, events) {
    const b = state.ball;
    const py0 = b.y;
    b.vz -= G * h;
    b.x += b.vx * h;
    b.y += b.vy * h;
    b.z += b.vz * h;

    // Red: al cruzar y=0 por debajo de su altura, dentro de su ancho.
    // Simplificación arcade deliberada: no hay "let" de saque — un saque que
    // roza la red y pasa, se juega.
    if ((py0 < 0) !== (b.y < 0) && b.z < NET_H && Math.abs(b.x) < NET_X) {
      b.y = py0 < 0 ? -0.5 : 0.5; // se queda en el lado del que venía
      b.vy *= -0.12;
      b.vx *= 0.5;
      state.netTouched = true;
      events.push({ type: 'net', x: b.x, z: b.z });
    }

    // Golpe de pala: la bola cruza el plano de la pala hacia la que viaja.
    const s = b.vy < 0 ? 0 : 1;
    if (b.vy !== 0) {
      const p = state.paddles[s];
      const crossed = s === 0 ? (py0 > p.y && b.y <= p.y) : (py0 < p.y && b.y >= p.y);
      if (crossed && Math.abs(b.x - p.x) < REACH_X && b.z > HIT_Z_MIN && b.z < HIT_Z_MAX) {
        hitBall(state, s, events);
        return;
      }
    }

    // Bote / suelo
    if (b.vz < 0) {
      const onTable = Math.abs(b.x) <= HALF_W && Math.abs(b.y) <= HALF_L;
      if (onTable && b.z <= 0) {
        b.z = 0;
        b.vz = -b.vz * TABLE_REST;
        b.vx *= BOUNCE_FRICTION;
        b.vy *= BOUNCE_FRICTION;
        const side = b.y < 0 ? 0 : 1;
        events.push({ type: 'bounce', side, x: b.x, y: b.y, speed: Math.hypot(b.vx, b.vy) });
        if (state.serving && !state.bouncedOwn) {
          if (side === state.lastTouch) state.bouncedOwn = true;
          else pointScored(state, 1 - state.lastTouch, 'serveFault', events);
        } else if (side === state.lastTouch) {
          // No cruzó (o volvió por la red): punto para el rival
          pointScored(state, 1 - state.lastTouch, state.netTouched ? 'net' : 'out', events);
        } else {
          state.serving = false; // saque completado
          state.recvBounces++;
          if (state.recvBounces >= 2) pointScored(state, state.lastTouch, 'double', events);
        }
      } else if (!onTable && b.z <= FLOOR_Z) {
        resolveGround(state, events); // cayó fuera de la mesa
      }
    }

    // Red de seguridad: si la bola sale disparada muy lejos se resuelve igual
    // que si hubiera tocado el suelo (misma atribución del punto).
    if (state.ball.live && (Math.abs(b.y) > 320 || Math.abs(b.x) > 260)) {
      resolveGround(state, events);
    }
  }

  // La bola ha muerto fuera de la mesa: si ya había botado en campo receptor,
  // el receptor no llegó (miss, punto para el que golpeó); si no, el golpe
  // salió fuera (out/net, punto para el rival del que golpeó).
  function resolveGround(state, events) {
    let winner, reason;
    if (state.recvBounces >= 1) { winner = state.lastTouch; reason = 'miss'; }
    else { winner = 1 - state.lastTouch; reason = state.netTouched ? 'net' : 'out'; }
    pointScored(state, winner, reason, events);
  }

  // Avanza la simulación dt segundos. Devuelve true si la bola sigue viva.
  function step(state, dt, events) {
    dt = Math.min(dt, 0.1);
    if (dt <= 0) return state.ball.live;
    // Mover palas hacia su objetivo y derivar velocidad (suavizada)
    for (const p of state.paddles) {
      const nvx = (p.tx - p.x) / dt;
      const nvy = (p.ty - p.y) / dt;
      p.vx = p.vx * 0.5 + clamp(nvx, -1500, 1500) * 0.5;
      p.vy = p.vy * 0.5 + clamp(nvy, -1500, 1500) * 0.5;
      p.x = p.tx; p.y = p.ty;
    }
    if (!state.ball.live) {
      if (state.phase === 'serve') glueBall(state);
      return false;
    }
    let t = dt;
    while (t > 1e-9 && state.ball.live) {
      const h = Math.min(SUB, t);
      substep(state, h, events);
      t -= h;
    }
    return state.ball.live;
  }

  // ¿Dónde cruzará la bola el plano y=planeY? Simula solo vuelo+botes de mesa
  // (ignora red y palas). Para la predicción de la IA — la comparte con el
  // motor para que "vea" la misma física.
  function predictX(ball, planeY) {
    const b = { x: ball.x, y: ball.y, z: ball.z, vx: ball.vx, vy: ball.vy, vz: ball.vz };
    let t = 0;
    const toward = planeY < b.y ? -1 : 1;
    if (b.vy === 0 || Math.sign(b.vy) !== toward) return { x: b.x, t: 0 };
    while (t < 3) {
      b.vz -= G * SUB;
      b.x += b.vx * SUB; b.y += b.vy * SUB; b.z += b.vz * SUB;
      t += SUB;
      if (b.z <= 0 && b.vz < 0 && Math.abs(b.x) <= HALF_W && Math.abs(b.y) <= HALF_L) {
        b.z = 0; b.vz = -b.vz * TABLE_REST; b.vx *= BOUNCE_FRICTION; b.vy *= BOUNCE_FRICTION;
      }
      if ((toward === -1 && b.y <= planeY) || (toward === 1 && b.y >= planeY)) break;
    }
    return { x: clamp(b.x, -PADDLE_X_MAX, PADDLE_X_MAX), t };
  }

  return {
    W, L, HALF_W, HALF_L, NET_H, NET_X, G, FLOOR_Z,
    PADDLE_Y, PADDLE_X_MAX, PADDLE_Y_MIN, PADDLE_Y_MAX, REACH_X, BALL_VIS_R,
    createState, setPaddle, serve, step, applyPoint, serverFor, predictX,
  };
});
