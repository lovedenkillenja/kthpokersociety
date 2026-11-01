document.addEventListener('DOMContentLoaded', () => {
  // Mobile hamburger menu toggle
  const hamburger = document.querySelector('.hamburger');
  const navLinks = document.querySelector('.nav-links');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', () => {
      navLinks.classList.toggle('active');
      const isExpanded = navLinks.classList.contains('active');
      hamburger.setAttribute('aria-expanded', isExpanded);
    });
  }

  // Pre-fill role based on URL parameter or data attribute on cards
  const urlParams = new URLSearchParams(window.location.search);
  const roleParam = urlParams.get('role');
  const roleSelect = document.getElementById('role');

  if (roleSelect && roleParam) {
    roleSelect.value = roleParam;
  }

  // Handle "Apply for role" clicks on board cards to scroll to form and pre-fill
  const applyLinks = document.querySelectorAll('a[data-role]');
  applyLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      if (window.location.pathname.endsWith('board.html') || window.location.pathname === '/' || window.location.pathname === '') {
        const role = link.getAttribute('data-role');
        if (roleSelect) {
          roleSelect.value = role;
        }
      }
    });
  });

  // Board Form Submission logic with Supabase
  const boardForm = document.getElementById('board-form');
  const formSuccess = document.getElementById('form-success');
  const formError = document.getElementById('form-error');

  if (boardForm) {
    // Supabase credentials (safe for browser)
    const SUPABASE_URL = "https://hrdqlaurdzyueviplbmj.supabase.co";
    const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_hKLPSwMbvmSNNnyj1osGfQ_uFgcnfPW";

    // Initialize Supabase client if available
    let supabase;
    if (window.supabase) {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    }

    boardForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const submitBtn = boardForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
      formSuccess.style.display = 'none';
      formError.style.display = 'none';

      const formData = new FormData(boardForm);
      const data = {
        full_name: formData.get('full_name'),
        email: formData.get('email'),
        program: formData.get('program') || null,
        role: formData.get('role'),
        motivation: formData.get('motivation') || null
      };

      if (!supabase) {
        console.error("Supabase client not loaded.");
        formError.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Application';
        return;
      }

      try {
        const { error } = await supabase
          .from('board_applications')
          .insert(data); // Insert only, no select

        if (error) throw error;

        formSuccess.style.display = 'block';
        boardForm.reset();
      } catch (err) {
        console.error("Submission error:", err);
        formError.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Application';
      }
    });
  }
});
