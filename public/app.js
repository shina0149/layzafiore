document.addEventListener('DOMContentLoaded', () => {
  const btnGeneratePix = document.getElementById('btn-generate-pix');
  const emailInput = document.getElementById('email');
  const loader = document.getElementById('loader');
  
  // Modal Elements
  const modal = document.getElementById('checkout-modal');
  const closeModalBtn = document.querySelector('.close-modal');
  const planButtons = document.querySelectorAll('.btn-select-plan');
  const selectedPlanText = document.getElementById('selected-plan-text');
  const modalFormStep = document.getElementById('modal-form-step');

  const pixArea = document.getElementById('pix-area');
  const pixQr = document.getElementById('pix-qr');
  const pixCode = document.getElementById('pix-code');
  const btnCopy = document.getElementById('btn-copy');
  const successArea = document.getElementById('success-area');
  const btnDelivery = document.getElementById('btn-delivery');

  let pollingInterval = null;
  let currentPlanId = null;

  // Open Modal
  planButtons.forEach(btn => {
      btn.addEventListener('click', () => {
          currentPlanId = btn.getAttribute('data-plan');
          const planName = btn.getAttribute('data-name');
          
          selectedPlanText.textContent = `Plano Selecto: ${planName}`;
          modal.style.display = 'flex';
          
          // Reset modal state
          modalFormStep.style.display = 'block';
          pixArea.style.display = 'none';
          successArea.style.display = 'none';
          btnGeneratePix.disabled = false;
          loader.style.display = 'none';
          if (pollingInterval) clearInterval(pollingInterval);
          
          // Small delay then focus email
          setTimeout(() => emailInput.focus(), 100);
      });
  });

  // Close Modal
  closeModalBtn.addEventListener('click', () => {
      modal.style.display = 'none';
  });

  window.addEventListener('click', (event) => {
      if (event.target == modal) {
          modal.style.display = 'none';
      }
  });

  btnGeneratePix.addEventListener('click', async () => {
      const email = emailInput.value.trim();

      if (!email || !email.includes('@')) {
          alert('Por favor, insira um e-mail válido.');
          return;
      }

      if (!currentPlanId) {
          alert('Plano inválido.');
          return;
      }

      // Update UI 
      btnGeneratePix.disabled = true;
      loader.style.display = 'block';

      try {
          const response = await fetch('/api/pix', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, planId: currentPlanId })
          });

          const data = await response.json();

          if (!response.ok) {
              throw new Error(data.error || 'Erro ao gerar o PIX');
          }

          // Show PIX area
          modalFormStep.style.display = 'none';
          pixArea.style.display = 'block';
          
          pixQr.src = `data:image/png;base64,${data.pix_qrcode}`;
          pixCode.value = data.pix_code;

          // Start polling
          startPolling(data.txid);

      } catch (error) {
          alert(`Erro: ${error.message}`);
          btnGeneratePix.disabled = false;
          loader.style.display = 'none';
      }
  });

  btnCopy.addEventListener('click', () => {
      pixCode.select();
      pixCode.setSelectionRange(0, 99999); 
      navigator.clipboard.writeText(pixCode.value).then(() => {
          const originalText = btnCopy.textContent;
          btnCopy.textContent = 'Copiado! ✅';
          btnCopy.style.background = '#008000';
          setTimeout(() => {
              btnCopy.textContent = originalText;
              btnCopy.style.background = '#000';
          }, 3000);
      }).catch(err => {
          console.error("Erro ao copiar:", err);
      });
  });

  function startPolling(txid) {
      pollingInterval = setInterval(async () => {
          try {
              const res = await fetch(`/api/status/${txid}`);
              const data = await res.json();

              if (data.status === 'paid') {
                  clearInterval(pollingInterval);
                  // Show Success!
                  pixArea.style.display = 'none';
                  successArea.style.display = 'block';

                  if (data.deliveryUrl) {
                      btnDelivery.href = data.deliveryUrl;
                  }
              }
          } catch (err) {
              console.error('Erro ao buscar status do PIX', err);
          }
      }, 3000);
  }

  // ========== Countdown Timer ==========
  function initCountdown() {
      const hoursEl = document.getElementById('countdown-hours');
      const minutesEl = document.getElementById('countdown-minutes');
      const secondsEl = document.getElementById('countdown-seconds');

      if (!hoursEl || !minutesEl || !secondsEl) return;

      let totalSeconds = 1 * 3600 + 1 * 60 + 1; // 1h 1m 1s

      function updateCountdown() {
          const h = Math.floor(totalSeconds / 3600);
          const m = Math.floor((totalSeconds % 3600) / 60);
          const s = totalSeconds % 60;

          hoursEl.textContent = String(h).padStart(2, '0');
          minutesEl.textContent = String(m).padStart(2, '0');
          secondsEl.textContent = String(s).padStart(2, '0');

          if (totalSeconds <= 0) {
              totalSeconds = 1 * 3600 + 1 * 60 + 1;
          } else {
              totalSeconds--;
          }
      }

      updateCountdown();
      setInterval(updateCountdown, 1000);
  }

  initCountdown();

  // ========== Social Proof Popup ==========
  function initSocialProof() {
      const popup = document.getElementById('social-proof-popup');
      if (!popup) return;

      const names = [
          'Lucas M.', 'André S.', 'Felipe R.', 'Guilherme P.',
          'Mateus B.', 'Pedro H.', 'Diego C.', 'Ricardo T.',
          'Bruno L.', 'Marcos V.', 'Caio A.', 'Vinícius F.'
      ];

      function showPopup() {
          const name = names[Math.floor(Math.random() * names.length)];
          popup.innerHTML = `<span class="social-proof-icon">🔔</span> ${name} acabou de <strong>Assinar um Plano!</strong>`;
          popup.classList.add('visible');

          setTimeout(() => {
              popup.classList.remove('visible');
          }, 4000);
      }

      // Show first popup after 5s delay
      setTimeout(() => {
          showPopup();
          // Then repeat every 8-15 seconds randomly
          setInterval(() => {
              const delay = Math.floor(Math.random() * 7000) + 8000;
              setTimeout(showPopup, delay);
          }, 15000);
      }, 5000);
  }

  initSocialProof();
});
