'use strict';
// All motion lives here. If GSAP doesn't load, or the visitor prefers reduced motion,
// the page stays complete and static, because the markup starts in its finished state.
(function () {
  if (!window.gsap || !window.ScrollTrigger) return;
  var gsap = window.gsap;
  var ScrollTrigger = window.ScrollTrigger;
  gsap.registerPlugin(ScrollTrigger);

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  // Wraps each word in spans. Real text stays in the page for screen readers and search.
  function splitWords(element) {
    var words = element.textContent.trim().split(/\s+/);
    element.textContent = '';
    return words.map(function (word, index) {
      var outer = document.createElement('span');
      var inner = document.createElement('span');
      outer.className = 'word';
      inner.textContent = word;
      outer.appendChild(inner);
      element.appendChild(outer);
      if (index < words.length - 1) element.appendChild(document.createTextNode(' '));
      return inner;
    });
  }

  function heroIntro() {
    var words = splitWords(document.getElementById('headline'));
    gsap.timeline({ defaults: { ease: 'power4.out' } })
      .from('.nav', { y: -24, autoAlpha: 0, duration: 0.7 })
      .from(words, { yPercent: 115, rotate: 5, duration: 1, stagger: 0.055 }, 0.1)
      .from('.hero-fade', { y: 24, autoAlpha: 0, duration: 0.8, stagger: 0.12 }, 0.6)
      .from('#demo', { x: 70, rotationY: -18, autoAlpha: 0, duration: 1.2 }, 0.35)
      .from('#network', { autoAlpha: 0, duration: 1.6 }, 0);
    gsap.to('#glow', { x: 60, y: 40, scale: 1.18, duration: 5, ease: 'sine.inOut', repeat: -1, yoyo: true });
  }

  function demoLoop() {
    var percent = document.getElementById('demo-percent');
    var progress = { value: 0 };
    var loop = gsap.timeline({ repeat: -1, repeatDelay: 0.3 });
    var hidden = ['.demo-bubble.theirs', '.demo-bubble.mine', '.demo-card'];

    loop
      .set(hidden, { autoAlpha: 0, y: 16, scale: 0.94 })
      .set('.demo-file', { opacity: 1, scale: 1 })
      .set('.demo-check', { opacity: 0, scale: 0.3 })
      .set('.demo-burst', { opacity: 0, scale: 1 })
      .set('.state-moving', { opacity: 1 })
      .set('.state-done', { opacity: 0 })
      .set('.demo-fill', { scaleX: 0 })
      .call(function () {
        progress.value = 0;
        percent.textContent = '0%';
      })
      .to('.demo-bubble.theirs', { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: 'back.out(1.8)' }, 0.25)
      .to('.demo-bubble.mine', { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: 'back.out(1.8)' }, 0.95)
      .to('.demo-card', { autoAlpha: 1, y: 0, scale: 1, duration: 0.55, ease: 'back.out(1.6)' }, 1.55)
      .to('.demo-fill', { scaleX: 1, duration: 2.6, ease: 'power1.inOut' }, 2.1)
      .to(progress, {
        value: 100,
        duration: 2.6,
        ease: 'power1.inOut',
        onUpdate: function () {
          percent.textContent = Math.round(progress.value) + '%';
        },
      }, 2.1);

    // Packets run along the bar while the file moves.
    all('.demo-track b').forEach(function (packet, index) {
      loop.fromTo(packet,
        { left: '0%', opacity: 0 },
        {
          keyframes: [{ opacity: 1, duration: 0.1 }, { left: '96%', duration: 0.65, ease: 'none' }, { opacity: 0, duration: 0.1 }],
          repeat: 2,
        },
        2.1 + index * 0.22);
    });

    loop
      .to('.face.b', { scale: 1.25, duration: 0.22, ease: 'power2.out', yoyo: true, repeat: 1 }, 4.7)
      .to('.demo-file', { opacity: 0, scale: 0.4, duration: 0.2 }, 4.72)
      .to('.demo-check', { opacity: 1, scale: 1, duration: 0.55, ease: 'elastic.out(1, 0.5)' }, 4.78)
      .fromTo('.demo-burst', { opacity: 0.9, scale: 1 }, { opacity: 0, scale: 2.5, duration: 0.8, ease: 'power2.out' }, 4.78)
      .to('.state-moving', { opacity: 0, duration: 0.15 }, 4.78)
      .to('.state-done', { opacity: 1, duration: 0.2 }, 4.85)
      .to(hidden, { autoAlpha: 0, y: -10, duration: 0.35, stagger: 0.05 }, '+=2');

    // Nothing runs while the demo is off screen.
    ScrollTrigger.create({
      trigger: '#demo',
      start: 'top bottom',
      end: 'bottom top',
      onToggle: function (self) {
        loop.paused(!self.isActive);
      },
    });

    var windowEl = document.querySelector('.demo-window');
    var demo = document.getElementById('demo');
    if (window.matchMedia('(hover: hover)').matches) {
      var tiltX = gsap.quickTo(windowEl, 'rotationX', { duration: 0.6, ease: 'power3.out' });
      var tiltY = gsap.quickTo(windowEl, 'rotationY', { duration: 0.6, ease: 'power3.out' });
      window.addEventListener('pointermove', function (event) {
        var box = demo.getBoundingClientRect();
        tiltY(((event.clientX - (box.left + box.width / 2)) / window.innerWidth) * 16);
        tiltX(((event.clientY - (box.top + box.height / 2)) / window.innerHeight) * -12);
      });
    }
  }

  function networkBackground() {
    var canvas = document.getElementById('network');
    var context = canvas.getContext('2d');
    var hero = document.querySelector('.hero');
    var nodes = [];
    var packets = [];
    var width = 0;
    var height = 0;
    var color = '#c2410c';
    var pointer = { x: -9999, y: -9999 };
    var LINK = 150;

    function resize() {
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = hero.clientWidth;
      height = hero.clientHeight;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      var count = Math.min(70, Math.round((width * height) / 19000));
      nodes = [];
      packets = [];
      for (var i = 0; i < count; i += 1) {
        nodes.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.24,
          vy: (Math.random() - 0.5) * 0.24,
          radius: 1.5 + Math.random() * 1.8,
        });
      }
    }

    function draw() {
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      context.strokeStyle = color;
      nodes.forEach(function (node) {
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < 0 || node.x > width) node.vx *= -1;
        if (node.y < 0 || node.y > height) node.vy *= -1;
      });
      for (var a = 0; a < nodes.length; a += 1) {
        for (var b = a + 1; b < nodes.length; b += 1) {
          var dx = nodes[a].x - nodes[b].x;
          var dy = nodes[a].y - nodes[b].y;
          var distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < LINK) {
            context.globalAlpha = (1 - distance / LINK) * 0.28;
            context.beginPath();
            context.moveTo(nodes[a].x, nodes[a].y);
            context.lineTo(nodes[b].x, nodes[b].y);
            context.stroke();
            if (packets.length < 10 && Math.random() < 0.0004) packets.push({ from: nodes[a], to: nodes[b], t: 0 });
          }
        }
      }
      nodes.forEach(function (node) {
        var near = Math.hypot(node.x - pointer.x, node.y - pointer.y) < 130;
        context.globalAlpha = near ? 0.95 : 0.42;
        context.beginPath();
        context.arc(node.x, node.y, near ? node.radius * 1.9 : node.radius, 0, Math.PI * 2);
        context.fill();
      });
      context.globalAlpha = 1;
      packets = packets.filter(function (packet) {
        packet.t += 0.016;
        var x = packet.from.x + (packet.to.x - packet.from.x) * packet.t;
        var y = packet.from.y + (packet.to.y - packet.from.y) * packet.t;
        context.beginPath();
        context.arc(x, y, 3, 0, Math.PI * 2);
        context.fill();
        return packet.t < 1;
      });
    }

    resize();
    draw();
    hero.addEventListener('pointermove', function (event) {
      var box = hero.getBoundingClientRect();
      pointer.x = event.clientX - box.left;
      pointer.y = event.clientY - box.top;
    });
    hero.addEventListener('pointerleave', function () {
      pointer.x = -9999;
    });
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });
    ScrollTrigger.create({
      trigger: hero,
      start: 'top bottom',
      end: 'bottom top',
      onToggle: function (self) {
        if (self.isActive) gsap.ticker.add(draw);
        else gsap.ticker.remove(draw);
      },
      onRefresh: function (self) {
        gsap.ticker.remove(draw);
        if (self.isActive) gsap.ticker.add(draw);
      },
    });
  }

  function marquee() {
    var track = document.querySelector('.marquee-track');
    var loop = gsap.to(track, { xPercent: -50, duration: 34, ease: 'none', repeat: -1 });
    // Scrolling speeds the strip up, then it eases back.
    ScrollTrigger.create({
      onUpdate: function (self) {
        var speed = 1 + Math.min(Math.abs(self.getVelocity()) / 260, 7);
        gsap.to(loop, { timeScale: self.direction * speed, duration: 0.2, overwrite: true });
        gsap.to(loop, { timeScale: self.direction, duration: 1.1, delay: 0.2 });
      },
    });
  }

  function storyTimeline(steps) {
    function activate(index) {
      steps.forEach(function (step, position) {
        step.classList.toggle('is-active', position === index);
      });
    }
    var machineB = document.querySelector('.machine.b');
    var end = machineB.offsetLeft - document.querySelector('.machine.a').offsetLeft;
    var timeline = gsap.timeline({ defaults: { ease: 'power2.inOut' } });
    var fade = 0.28;

    var later = { immediateRender: false };
    function from(values) {
      return Object.assign({}, values, later);
    }

    // Worked out from the time, so it's also right when scrolling backwards.
    timeline.eventCallback('onUpdate', function () {
      var time = timeline.time();
      activate(time < 1.35 ? 0 : time < 2.7 ? 1 : time < 4.4 ? 2 : 3);
    });
    activate(0);

    timeline
      .set(machineB, { autoAlpha: 0.25 }, 0)
      .set('.wire-fill', { scaleX: 0 }, 0)
      .set('.stage-check', { opacity: 0, scale: 0.2 }, 0)
      .fromTo('.ripple.left', from({ scale: 0.2, opacity: 0.8 }), { scale: 1, opacity: 0, duration: 0.9, stagger: 0.25, ease: 'power1.out' }, 0.05)
      .fromTo('.ripple.right', from({ scale: 0.2, opacity: 0.8 }), { scale: 1, opacity: 0, duration: 0.9, stagger: 0.25, ease: 'power1.out' }, 0.6)
      .to(machineB, { autoAlpha: 1, duration: 0.3 }, 0.55)
      .to('.wire-fill', { scaleX: 1, duration: 0.4 }, 0.85);

    timeline
      .fromTo('.flyer.message', from({ x: 0, opacity: 0, scale: 0.7 }), { opacity: 1, scale: 1, duration: fade }, 1.4)
      .to('.flyer.message', { x: end, duration: 0.75 }, 1.65)
      .to('.flyer.message', { opacity: 0, scale: 0.7, duration: fade }, 2.35);

    timeline
      .fromTo('.flyer.folder', from({ x: 0, y: -46, opacity: 0, scale: 0.6, rotate: -9 }), { y: 0, opacity: 1, scale: 1, rotate: 0, duration: 0.42, ease: 'back.out(2)' }, 2.75)
      .set('.wire-fill', { scaleX: 0 }, 3.15)
      .to('.flyer.folder', { x: end, duration: 1 }, 3.2)
      .to('.wire-fill', { scaleX: 1, duration: 1 }, 3.2)
      .to('.flyer.folder', { opacity: 0, scale: 0.5, duration: fade }, 4.15);

    timeline
      .to('.stage-check', { opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(3)' }, 4.45)
      .fromTo('.ripple.right', from({ scale: 0.2, opacity: 0.8 }), { scale: 1.2, opacity: 0, duration: 0.8, stagger: 0.18, ease: 'power1.out' }, 4.45)
      .to({}, { duration: 0.5 });
    return timeline;
  }

  function story() {
    var steps = all('.story-step');
    var media = gsap.matchMedia();
    // Wide screens pin the section, and scrolling plays the story. Phones loop it in view instead.
    media.add('(min-width: 961px)', function () {
      var timeline = storyTimeline(steps);
      ScrollTrigger.create({
        animation: timeline,
        trigger: '.story',
        start: 'top top',
        end: '+=1800',
        pin: true,
        scrub: 0.5,
        anticipatePin: 1,
      });
      gsap.from('.stage', { scale: 0.92, autoAlpha: 0, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: '.story', start: 'top 75%' } });
      gsap.from('.steps-list > *', { x: -36, autoAlpha: 0, duration: 0.7, stagger: 0.08, ease: 'power3.out', scrollTrigger: { trigger: '.story', start: 'top 75%' } });
    });
    media.add('(max-width: 960px)', function () {
      var timeline = storyTimeline(steps).repeat(-1).repeatDelay(0.8);
      ScrollTrigger.create({
        trigger: '.stage',
        start: 'top bottom',
        end: 'bottom top',
        onToggle: function (self) {
          timeline.paused(!self.isActive);
        },
      });
    });
  }

  function statement() {
    var words = splitWords(document.getElementById('statement'));
    gsap.fromTo(words,
      { color: getComputedStyle(document.documentElement).getPropertyValue('--dim-word').trim() },
      {
        color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
        stagger: 0.1,
        ease: 'none',
        scrollTrigger: { trigger: '#statement', start: 'top 82%', end: 'bottom 48%', scrub: 0.4 },
      });
  }

  function reveals() {
    gsap.to('#scroll-progress', { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: 0.2 } });

    all('.reveal-heading').forEach(function (heading) {
      gsap.from(heading, { y: 44, autoAlpha: 0, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: heading, start: 'top 88%' } });
    });
    gsap.from('.feature', {
      y: 54,
      rotateX: -14,
      transformPerspective: 800,
      autoAlpha: 0,
      duration: 0.8,
      stagger: 0.07,
      ease: 'power3.out',
      scrollTrigger: { trigger: '.grid', start: 'top 86%' },
    });
    all('.download').forEach(function (row, index) {
      gsap.from(row, { x: index % 2 ? 70 : -70, autoAlpha: 0, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: row, start: 'top 92%' } });
    });
    all('.reveal-card').forEach(function (card) {
      gsap.from(card, { y: 28, autoAlpha: 0, duration: 0.7, ease: 'power2.out', scrollTrigger: { trigger: card, start: 'top 92%' } });
    });

    // The glow on each card follows the pointer.
    all('.feature').forEach(function (card) {
      card.addEventListener('pointermove', function (event) {
        var box = card.getBoundingClientRect();
        card.style.setProperty('--x', event.clientX - box.left + 'px');
        card.style.setProperty('--y', event.clientY - box.top + 'px');
      });
    });
  }

  function magneticButtons() {
    if (!window.matchMedia('(hover: hover)').matches) return;
    all('.magnetic').forEach(function (button) {
      var moveX = gsap.quickTo(button, 'x', { duration: 0.4, ease: 'power3.out' });
      var moveY = gsap.quickTo(button, 'y', { duration: 0.4, ease: 'power3.out' });
      button.addEventListener('pointermove', function (event) {
        var box = button.getBoundingClientRect();
        moveX((event.clientX - box.left - box.width / 2) * 0.28);
        moveY((event.clientY - box.top - box.height / 2) * 0.28);
      });
      button.addEventListener('pointerleave', function () {
        moveX(0);
        moveY(0);
      });
    });
  }

  function smoothAnchors() {
    all('a[href^="#"]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        var target = document.querySelector(link.getAttribute('href'));
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      });
    });
  }

  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', function () {
    heroIntro();
    demoLoop();
    networkBackground();
    marquee();
    story();
    statement();
    reveals();
    magneticButtons();
    smoothAnchors();
  });

  // Fonts and layout can shift section positions after load.
  window.addEventListener('load', function () {
    ScrollTrigger.refresh();
  });
})();
