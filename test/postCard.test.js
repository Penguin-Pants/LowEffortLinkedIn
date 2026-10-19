const { buildPostCard, isPostExpired, postCardText } = require('../src/blocks/postCard');

function post(overrides = {}) {
  return {
    id: 'post-1',
    destination_url: 'https://example.com/launch',
    caption_a: 'Caption A text',
    caption_b: null,
    caption_c: null,
    image_slack_file_id: null,
    created_by_slack_id: 'U_MARKETER',
    created_at: '2026-07-02T12:00:00Z',
    ...overrides,
  };
}

function actionIds(blocks) {
  const actions = blocks.find((b) => b.type === 'actions');
  return actions.elements.map((e) => e.action_id);
}

describe('buildPostCard', () => {
  test('renders share buttons only for filled-in captions, plus custom edit', () => {
    const blocks = buildPostCard({ post: post(), shareCount: 0 });
    expect(actionIds(blocks)).toEqual(['share_variation_a', 'edit_share_custom']);
  });

  test('renders all three share buttons when B and C are filled', () => {
    const blocks = buildPostCard({
      post: post({ caption_b: 'B text', caption_c: 'C text' }),
      shareCount: 0,
    });
    expect(actionIds(blocks)).toEqual([
      'share_variation_a',
      'share_variation_b',
      'share_variation_c',
      'edit_share_custom',
    ]);
  });

  test('buttons carry post_id and variation in their value', () => {
    const blocks = buildPostCard({ post: post({ caption_b: 'B' }), shareCount: 0 });
    const actions = blocks.find((b) => b.type === 'actions');
    expect(JSON.parse(actions.elements[0].value)).toEqual({ post_id: 'post-1', variation: 'A' });
    expect(JSON.parse(actions.elements[1].value)).toEqual({ post_id: 'post-1', variation: 'B' });
    expect(JSON.parse(actions.elements[2].value)).toEqual({ post_id: 'post-1' });
  });

  test('includes an image block only when the post has an image', () => {
    const without = buildPostCard({ post: post(), shareCount: 0 });
    expect(without.some((b) => b.type === 'image')).toBe(false);

    const withImage = buildPostCard({ post: post({ image_slack_file_id: 'F123' }), shareCount: 0 });
    const image = withImage.find((b) => b.type === 'image');
    expect(image.slack_file).toEqual({ id: 'F123' });
  });

  test('context line shows the marketer and the share count', () => {
    const blocks = buildPostCard({ post: post(), shareCount: 12 });
    const context = blocks[blocks.length - 1];
    expect(context.type).toBe('context');
    expect(context.elements[0].text).toContain('<@U_MARKETER>');
    expect(context.elements[0].text).toContain('✅ 12 shares');
  });

  test('a full 3000-char caption stays within the section block limit', () => {
    const long = 'x'.repeat(3000);
    const blocks = buildPostCard({ post: post({ caption_a: long }), shareCount: 0 });
    const sections = blocks.filter((b) => b.type === 'section');
    for (const section of sections) {
      expect(section.text.text.length).toBeLessThanOrEqual(3000);
    }
  });

  test('escapes mrkdwn control characters in captions and the URL', () => {
    const blocks = buildPostCard({
      post: post({
        caption_a: 'Ping <!channel> & follow <https://evil|this>',
        destination_url: 'https://example.com/?a=1&b=2',
      }),
      shareCount: 0,
    });
    const texts = blocks
      .filter((b) => b.type === 'section')
      .map((b) => b.text.text)
      .join('\n');
    expect(texts).not.toContain('<!channel>');
    expect(texts).toContain('&lt;!channel&gt;');
    expect(texts).toContain('https://example.com/?a=1&amp;b=2');
  });

  describe('sharing expiry', () => {
    test('an active post with expires_at shows a "closes" segment and keeps its buttons', () => {
      const blocks = buildPostCard({
        post: post({ expires_at: '2026-07-02T20:00:00Z' }),
        shareCount: 3,
      });
      expect(blocks.some((b) => b.type === 'actions')).toBe(true);
      const context = blocks[blocks.length - 1];
      expect(context.elements[0].text).toContain('✅ 3 shares');
      expect(context.elements[0].text).toContain('Sharing closes');
      expect(context.elements[0].text).not.toContain('Sharing closed');
    });

    test('an active post with no expires_at shows neither segment', () => {
      const blocks = buildPostCard({ post: post(), shareCount: 0 });
      const context = blocks[blocks.length - 1];
      expect(context.elements[0].text).not.toContain('Sharing closes');
      expect(context.elements[0].text).not.toContain('Sharing closed');
    });

    test('an expired post has no actions block and shows "Sharing closed"', () => {
      const blocks = buildPostCard({
        post: post({ expires_at: '2026-07-02T20:00:00Z', expired_at: '2026-07-02T20:01:00Z' }),
        shareCount: 4,
      });
      expect(blocks.some((b) => b.type === 'actions')).toBe(false);
      const context = blocks[blocks.length - 1];
      expect(context.elements[0].text).toContain('✅ 4 shares');
      expect(context.elements[0].text).toContain('⏰ Sharing closed');
      expect(context.elements[0].text).not.toContain('Sharing closes <!date');
    });

    test('an expired post still renders captions and the image, just no buttons', () => {
      const blocks = buildPostCard({
        post: post({
          caption_b: 'B text',
          image_slack_file_id: 'F123',
          expired_at: '2026-07-02T20:01:00Z',
        }),
        shareCount: 1,
      });
      expect(blocks.some((b) => b.type === 'image')).toBe(true);
      expect(blocks.some((b) => b.type === 'section' && b.text.text === 'B text')).toBe(true);
      expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    });
  });
});

describe('isPostExpired', () => {
  const now = new Date('2026-07-02T09:00:00Z');

  test('a post with no expiry never expires', () => {
    expect(isPostExpired({ expires_at: null }, now)).toBe(false);
  });

  test('expired at or after expires_at, open before it', () => {
    expect(isPostExpired({ expires_at: new Date(now.getTime() - 1) }, now)).toBe(true);
    expect(isPostExpired({ expires_at: now }, now)).toBe(true);
    expect(isPostExpired({ expires_at: new Date(now.getTime() + 1) }, now)).toBe(false);
  });

  test('accepts the ISO string a DB driver may return', () => {
    expect(isPostExpired({ expires_at: '2026-07-01T00:00:00Z' }, now)).toBe(true);
  });
});

describe('postCardText', () => {
  test('is the notification/fallback text for every card send and update', () => {
    expect(postCardText({ destination_url: 'https://example.com/a' })).toBe(
      'New post ready to share: https://example.com/a'
    );
  });
});
