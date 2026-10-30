import { describe, it, expect } from 'vitest';

import { mount } from '@vue/test-utils';
import App from './App.vue';

describe('App', () => {
  it('renders properly', () => {
    const wrapper = mount(App, {
      global: {
        stubs: { 'router-view': { template: '<main>routed view</main>' } },
      },
    });
    expect(wrapper.text()).toContain('routed view');
  });
});
