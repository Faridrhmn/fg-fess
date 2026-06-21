document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('messageForm');
    const submitBtn = document.getElementById('submitBtn');
    const replyContainer = document.getElementById('replyContainer');
    const aiReply = document.getElementById('aiReply');
    const writeAnotherBtn = document.getElementById('writeAnotherBtn');
    const messageBox = document.getElementById('messageBox');
    
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const message = messageBox.value.trim();
            if (!message) return;
            
            submitBtn.disabled = true;
            submitBtn.textContent = 'Sending...';
            
            try {
                const response = await fetch('/api/submit', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ message })
                });
                
                const data = await response.json();
                
                if (response.ok) {
                    form.parentElement.classList.add('hidden');
                    replyContainer.classList.remove('hidden');
                    aiReply.textContent = data.reply;
                    messageBox.value = '';
                } else {
                    alert('Failed to send message. Please try again.');
                }
            } catch (error) {
                console.error('Error:', error);
                alert('Network error occurred.');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Send Message';
            }
        });
    }
    
    if (writeAnotherBtn) {
        writeAnotherBtn.addEventListener('click', () => {
            replyContainer.classList.add('hidden');
            form.parentElement.classList.remove('hidden');
            messageBox.focus();
        });
    }
});
