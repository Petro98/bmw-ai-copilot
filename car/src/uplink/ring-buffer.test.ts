import { expect, test } from 'vitest';
import { RingBuffer } from './ring-buffer';

test('the ring buffer keeps the newest 240 and drains oldest first', () => {
  const buffer = new RingBuffer<number>(240);
  for (let i = 0; i < 1000; i++) buffer.push(i);
  expect(buffer.size()).toBe(240);
  expect(buffer.drain(60)).toEqual(Array.from({ length: 60 }, (_, i) => 760 + i));
  expect(buffer.size()).toBe(180);
  expect(buffer.drain(1000)).toEqual(Array.from({ length: 180 }, (_, i) => 820 + i));
  expect(buffer.size()).toBe(0);
  expect(buffer.drain(10)).toEqual([]);
});

test('drain of zero or a negative count takes nothing', () => {
  const buffer = new RingBuffer<string>(3);
  buffer.push('a');
  expect(buffer.drain(0)).toEqual([]);
  expect(buffer.drain(-1)).toEqual([]);
  expect(buffer.size()).toBe(1);
});

test('wraps around repeatedly without losing order', () => {
  const buffer = new RingBuffer<number>(5);
  const model: number[] = [];
  let next = 0;
  for (let round = 0; round < 50; round++) {
    for (let i = 0; i < 3; i++) {
      buffer.push(next);
      model.push(next++);
      if (model.length > 5) model.shift();
    }
    expect(buffer.drain(2)).toEqual(model.splice(0, 2));
    expect(buffer.size()).toBe(model.length);
  }
});

test('pushFront puts a failed batch back in front, keeping the newest within capacity', () => {
  const buffer = new RingBuffer<number>(5);
  for (let i = 0; i < 5; i++) buffer.push(i);
  const batch = buffer.drain(3); // 0, 1, 2
  buffer.push(5);
  buffer.pushFront(batch); // 0..5 is six items: the oldest (0) is dropped
  expect(buffer.size()).toBe(5);
  expect(buffer.drain(10)).toEqual([1, 2, 3, 4, 5]);
  buffer.pushFront([7, 8]);
  expect(buffer.drain(10)).toEqual([7, 8]);
});

test('a capacity below one is treated as one', () => {
  const buffer = new RingBuffer<number>(0);
  buffer.push(1);
  buffer.push(2);
  expect(buffer.drain(5)).toEqual([2]);
});
